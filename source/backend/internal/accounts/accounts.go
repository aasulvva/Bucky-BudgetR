// Package accounts manages bank accounts (spec §2): creating one with its
// opening balance, renaming, adjusting the balance and deleting.
//
// Every change that moves money goes through the ledger in the same database
// transaction as the account change, so an account never exists without its
// opening balance, and is never deleted with money or buckets left on it.
package accounts

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/balance"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
)

// Errors returned by the service. They wrap a message that says what is wrong.
var (
	// ErrNotFound means the account doesn't exist, isn't the user's or is
	// deleted.
	ErrNotFound = errors.New("not found")
	// ErrInvalid means the request breaks a rule.
	ErrInvalid = errors.New("invalid")
	// ErrNameTaken means the user has another account with this name.
	ErrNameTaken = errors.New("an account with this name already exists")
	// ErrNoChange means a balance adjustment wouldn't change the balance.
	ErrNoChange = errors.New("the balance is already this amount")
	// ErrCurrencyMismatch means money or buckets would move between accounts
	// in different currencies.
	ErrCurrencyMismatch = errors.New("the accounts have different currencies")
	// ErrBalanceNotZero is wrapped by *BalanceNotZeroError.
	ErrBalanceNotZero = errors.New("the account still has money in it")
	// ErrHasBuckets is wrapped by *HasBucketsError.
	ErrHasBuckets = errors.New("buckets still use the account as their source")
)

// BalanceNotZeroError means an account can't be deleted until its remaining
// money is transferred or adjusted away.
type BalanceNotZeroError struct{ Balance decimal.Decimal }

func (e *BalanceNotZeroError) Error() string {
	return fmt.Sprintf("%s: %s", ErrBalanceNotZero, e.Balance.StringFixed(money.Places))
}

func (e *BalanceNotZeroError) Unwrap() error { return ErrBalanceNotZero }

// HasBucketsError means an account can't be deleted until these buckets get
// another source account.
type HasBucketsError struct{ BucketIDs []string }

func (e *HasBucketsError) Error() string {
	return fmt.Sprintf("%s: %s", ErrHasBuckets, strings.Join(e.BucketIDs, ", "))
}

func (e *HasBucketsError) Unwrap() error { return ErrHasBuckets }

// MaxName is the longest account name, in characters.
const MaxName = 100

// DefaultCurrency is used when an account is created without one.
const DefaultCurrency = "NOK"

// Account is a bank account with its calculated balance.
type Account struct {
	ID        string
	Name      string
	Type      sqlc.AccountType
	Currency  string
	Balance   decimal.Decimal
	CreatedAt time.Time
}

// New describes an account to create.
type New struct {
	Name string
	// Type defaults to usage.
	Type sqlc.AccountType
	// Currency defaults to DefaultCurrency. It can't be changed later.
	Currency string
	// OpeningBalance is recorded as an Opening Balance (OPB) transaction at
	// OpeningAt (default now). Zero records nothing.
	OpeningBalance decimal.Decimal
	OpeningAt      time.Time
}

// Changes are the fields to update; nil leaves a field as it is.
type Changes struct {
	Name *string
	Type *sqlc.AccountType
}

// Adjustment sets the balance to Target as of At (default now) with a
// Balance Adjustment (BLA) for the difference.
type Adjustment struct {
	Target decimal.Decimal
	At     time.Time
}

// Settlement is how an account is cleared before it is deleted.
type Settlement struct {
	// Remaining says what happens to money left in the account. It is only
	// needed when the balance isn't zero.
	Remaining *Remaining
	// BucketSources gives every live bucket funded from the account a new
	// source account: bucket ID → account ID.
	BucketSources map[string]string
}

// Remaining moves the remaining balance: a transfer (TRF) to TransferTo, or,
// with Adjust, a balance adjustment (BLA) to zero. Set exactly one.
type Remaining struct {
	TransferTo string
	Adjust     bool
}

// Options configures a Service.
type Options struct {
	// Now returns the current time. Defaults to time.Now.
	Now func() time.Time
}

// Service manages bank accounts.
type Service struct {
	pool   *pgxpool.Pool
	ledger *ledger.Ledger
	now    func() time.Time
}

// NewService returns a Service that records money movements in l.
func NewService(pool *pgxpool.Pool, l *ledger.Ledger, opts Options) *Service {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Service{pool: pool, ledger: l, now: opts.Now}
}

// List returns the user's accounts, sorted by name.
func (s *Service) List(ctx context.Context, userID string) ([]Account, error) {
	q := sqlc.New(s.pool)
	rows, err := q.ListAccounts(ctx, userID)
	if err != nil {
		return nil, err
	}
	balances, err := balance.Accounts(ctx, s.pool, userID)
	if err != nil {
		return nil, err
	}
	out := make([]Account, len(rows))
	for i, r := range rows {
		out[i] = toAccount(r, balances[r.ID])
	}
	return out, nil
}

// Get returns one of the user's accounts.
func (s *Service) Get(ctx context.Context, userID, id string) (Account, error) {
	return s.get(ctx, s.pool, userID, id)
}

// Create creates an account and its opening balance.
func (s *Service) Create(ctx context.Context, userID string, n New) (Account, error) {
	name, err := checkName(n.Name)
	if err != nil {
		return Account{}, err
	}
	if n.Type == "" {
		n.Type = sqlc.AccountTypeUsage
	}
	if !n.Type.Valid() {
		return Account{}, fmt.Errorf("%w: account type %q", ErrInvalid, n.Type)
	}
	if n.Currency == "" {
		n.Currency = DefaultCurrency
	}
	if err := money.ValidCurrency(n.Currency); err != nil {
		return Account{}, fmt.Errorf("%w: %w", ErrInvalid, err)
	}
	if err := money.Valid(n.OpeningBalance); err != nil {
		return Account{}, fmt.Errorf("%w: opening balance: %w", ErrInvalid, err)
	}
	if n.OpeningAt.IsZero() {
		n.OpeningAt = s.now()
	}

	var out Account
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := sqlc.New(tx)
		var row sqlc.BankAccount
		_, err := ids.Insert(ctx, ids.Account, ids.NewAccount, func(ctx context.Context, id string) (bool, error) {
			var err error
			row, err = q.CreateAccount(ctx, sqlc.CreateAccountParams{
				ID: id, UserID: userID, Name: name, Currency: n.Currency, AccountType: n.Type,
			})
			return ids.Inserted(err)
		})
		if err != nil {
			return nameTaken(err)
		}
		if !n.OpeningBalance.IsZero() {
			if _, err := s.ledger.Record(ctx, tx, ledger.Entry{
				UserID: userID, CreatedBy: userID, Type: sqlc.TransactionTypeOPB, At: n.OpeningAt,
				BankLines: []ledger.BankLine{{AccountID: row.ID, Amount: n.OpeningBalance}},
			}); err != nil {
				return fmt.Errorf("record opening balance: %w", err)
			}
		}
		out = toAccount(row, n.OpeningBalance)
		return nil
	})
	if err != nil {
		return Account{}, err
	}
	return out, nil
}

// Update changes an account's name or type.
func (s *Service) Update(ctx context.Context, userID, id string, c Changes) (Account, error) {
	var out Account
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := sqlc.New(tx)
		row, err := q.GetAccountForUpdate(ctx, sqlc.GetAccountForUpdateParams{ID: id, UserID: userID})
		if err != nil {
			return notFound(err, id)
		}
		params := sqlc.UpdateAccountParams{ID: id, UserID: userID, Name: row.Name, AccountType: row.AccountType}
		if c.Name != nil {
			if params.Name, err = checkName(*c.Name); err != nil {
				return err
			}
		}
		if c.Type != nil {
			if !c.Type.Valid() {
				return fmt.Errorf("%w: account type %q", ErrInvalid, *c.Type)
			}
			params.AccountType = *c.Type
		}
		if _, err := q.UpdateAccount(ctx, params); err != nil {
			return nameTaken(err)
		}
		out, err = s.get(ctx, tx, userID, id)
		return err
	})
	if err != nil {
		return Account{}, err
	}
	return out, nil
}

// AdjustBalance records a Balance Adjustment (BLA) so that the balance as of
// a.At, counting transactions at or before it, becomes a.Target. It returns
// the account with its current balance.
func (s *Service) AdjustBalance(ctx context.Context, userID, id string, a Adjustment) (Account, error) {
	if err := money.Valid(a.Target); err != nil {
		return Account{}, fmt.Errorf("%w: target balance: %w", ErrInvalid, err)
	}
	if a.At.IsZero() {
		a.At = s.now()
	}
	at := a.At.UTC().Truncate(time.Microsecond) // as the ledger stores it

	var out Account
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := sqlc.New(tx).GetAccountForUpdate(ctx, sqlc.GetAccountForUpdateParams{ID: id, UserID: userID}); err != nil {
			return notFound(err, id)
		}
		balances, err := balance.AccountsBefore(ctx, tx, userID, at.Add(time.Microsecond))
		if err != nil {
			return err
		}
		diff := a.Target.Sub(balances[id])
		if diff.IsZero() {
			return ErrNoChange
		}
		if _, err := s.ledger.Record(ctx, tx, ledger.Entry{
			UserID: userID, CreatedBy: userID, Type: sqlc.TransactionTypeBLA, At: at,
			BankLines: []ledger.BankLine{{AccountID: id, Amount: diff}},
		}); err != nil {
			return fmt.Errorf("record balance adjustment: %w", err)
		}
		out, err = s.get(ctx, tx, userID, id)
		return err
	})
	if err != nil {
		return Account{}, err
	}
	return out, nil
}

// Delete soft-deletes an account after settling it, all in one database
// transaction: every live bucket funded from it moves to the source in
// st.BucketSources, and remaining money is transferred or adjusted away as
// st.Remaining says. Without those it returns *HasBucketsError or
// *BalanceNotZeroError and changes nothing. The account's transactions stay.
func (s *Service) Delete(ctx context.Context, userID, id string, st Settlement) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := sqlc.New(tx)
		acc, err := q.GetAccountForUpdate(ctx, sqlc.GetAccountForUpdateParams{ID: id, UserID: userID})
		if err != nil {
			return notFound(err, id)
		}

		buckets, err := q.ListSourceBuckets(ctx, sqlc.ListSourceBucketsParams{SourceAccountID: id, UserID: userID})
		if err != nil {
			return err
		}
		for b := range st.BucketSources {
			if !slices.Contains(buckets, b) {
				return fmt.Errorf("%w: bucket %s isn't funded from account %s", ErrInvalid, b, id)
			}
		}
		var missing []string
		for _, b := range buckets {
			if _, ok := st.BucketSources[b]; !ok {
				missing = append(missing, b)
			}
		}
		if len(missing) > 0 {
			return &HasBucketsError{BucketIDs: missing}
		}
		targets := slices.Collect(maps.Values(st.BucketSources))
		if r := st.Remaining; r != nil && r.TransferTo != "" {
			targets = append(targets, r.TransferTo)
		}
		if err := s.checkTargets(ctx, q, userID, acc, targets); err != nil {
			return err
		}

		balances, err := balance.Accounts(ctx, tx, userID)
		if err != nil {
			return err
		}
		if bal := balances[id]; !bal.IsZero() {
			if err := s.settle(ctx, tx, userID, id, bal, st.Remaining); err != nil {
				return err
			}
		}

		for _, b := range buckets {
			if err := q.SetBucketSource(ctx, sqlc.SetBucketSourceParams{ID: b, UserID: userID, SourceAccountID: st.BucketSources[b]}); err != nil {
				return err
			}
		}
		return q.DeleteAccount(ctx, sqlc.DeleteAccountParams{ID: id, UserID: userID})
	})
}

// checkTargets checks that money or buckets can move from acc to each target:
// another live account of the user, in the same currency.
func (s *Service) checkTargets(ctx context.Context, q *sqlc.Queries, userID string, acc sqlc.BankAccount, targets []string) error {
	if len(targets) == 0 {
		return nil
	}
	rows, err := q.GetOwnedAccounts(ctx, sqlc.GetOwnedAccountsParams{Ids: targets, UserID: userID})
	if err != nil {
		return err
	}
	for _, t := range targets {
		if t == acc.ID {
			return fmt.Errorf("%w: can't move money or buckets to the account being deleted", ErrInvalid)
		}
		i := slices.IndexFunc(rows, func(r sqlc.GetOwnedAccountsRow) bool { return r.ID == t })
		if i < 0 {
			return fmt.Errorf("%w: account %s doesn't exist", ErrInvalid, t)
		}
		if rows[i].Currency != acc.Currency {
			return fmt.Errorf("%w: %s is %s, %s is %s", ErrCurrencyMismatch, acc.ID, acc.Currency, t, rows[i].Currency)
		}
	}
	return nil
}

// settle moves bal out of the account as r says.
func (s *Service) settle(ctx context.Context, tx pgx.Tx, userID, id string, bal decimal.Decimal, r *Remaining) error {
	if r == nil {
		return &BalanceNotZeroError{Balance: bal}
	}
	e := ledger.Entry{UserID: userID, CreatedBy: userID, At: s.now()}
	switch {
	case r.Adjust && r.TransferTo == "":
		e.Type = sqlc.TransactionTypeBLA
		e.BankLines = []ledger.BankLine{{AccountID: id, Amount: bal.Neg()}}
	case !r.Adjust && r.TransferTo != "":
		e.Type = sqlc.TransactionTypeTRF
		e.BankLines = []ledger.BankLine{{AccountID: id, Amount: bal.Neg()}, {AccountID: r.TransferTo, Amount: bal}}
	default:
		return fmt.Errorf("%w: choose either a transfer or a balance adjustment for the remaining money", ErrInvalid)
	}
	if _, err := s.ledger.Record(ctx, tx, e); err != nil {
		return fmt.Errorf("settle remaining money: %w", err)
	}
	return nil
}

func (s *Service) get(ctx context.Context, db sqlc.DBTX, userID, id string) (Account, error) {
	row, err := sqlc.New(db).GetAccount(ctx, sqlc.GetAccountParams{ID: id, UserID: userID})
	if err != nil {
		return Account{}, notFound(err, id)
	}
	balances, err := balance.Accounts(ctx, db, userID)
	if err != nil {
		return Account{}, err
	}
	return toAccount(row, balances[id]), nil
}

func toAccount(r sqlc.BankAccount, bal decimal.Decimal) Account {
	return Account{
		ID: r.ID, Name: r.Name, Type: r.AccountType, Currency: r.Currency,
		Balance: bal, CreatedAt: r.CreatedAt,
	}
}

func checkName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", fmt.Errorf("%w: the name is empty", ErrInvalid)
	}
	if utf8.RuneCountInString(name) > MaxName {
		return "", fmt.Errorf("%w: the name is longer than %d characters", ErrInvalid, MaxName)
	}
	return name, nil
}

func notFound(err error, id string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: account %s", ErrNotFound, id)
	}
	return err
}

// nameTaken turns a clash on the unique name index into ErrNameTaken.
func nameTaken(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "bank_accounts_user_name_key" {
		return ErrNameTaken
	}
	return err
}
