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
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/allocation"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/balance"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/bsu"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cards"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/schedules"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/stats"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
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
	// ErrBSUCurrency means a BSU account would be in another currency than
	// NOK (#214).
	ErrBSUCurrency = errors.New("a BSU account must be in NOK")
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

// MaxBank is the longest bank name, in characters.
const MaxBank = 100

// DefaultCurrency is used when an account is created without one.
const DefaultCurrency = "NOK"

// Account is a bank account with its calculated balance.
type Account struct {
	ID       string
	Name     string
	Type     sqlc.AccountType
	Currency string
	// Bank is the bank the account is in (#70), "" when not given.
	Bank    string
	Balance decimal.Decimal
	// Unallocated is the part of the balance that neither a bucket's CAF nor
	// a savings reservation uses (spec §7, §8).
	Unallocated decimal.Decimal
	// Reserved is what's held on the account for savings (#231), and
	// ReservedUncovered the part of it the balance doesn't cover, since the
	// buckets are funded first.
	Reserved          decimal.Decimal
	ReservedUncovered decimal.Decimal
	// CardHolds is what's held on the account per credit card (#261), and
	// CardDebtUncovered the part of their sum the balance doesn't cover.
	CardHolds         map[string]decimal.Decimal
	CardDebtUncovered decimal.Decimal
	// ExpectedIncome is the income expected per cycle, for Budget setup
	// (spec §9). Invalid until entered.
	ExpectedIncome decimal.NullDecimal
	CreatedAt      time.Time
	// BSU is a BSU account's deposits against this year's limits (#214);
	// nil for other types.
	BSU *bsu.Status
	// Card is a credit card's fields and what's owed (#260); nil for other
	// types.
	Card *cards.Status
}

// New describes an account to create.
type New struct {
	Name string
	// Type defaults to usage.
	Type sqlc.AccountType
	// Currency defaults to DefaultCurrency. It can't be changed later.
	Currency string
	// Bank is optional.
	Bank string
	// OpeningBalance is recorded as an Opening Balance (OPB) transaction at
	// OpeningAt (default now). Zero records nothing.
	OpeningBalance decimal.Decimal
	OpeningAt      time.Time
	// Card is a credit card's fields, needed exactly when Type is a card
	// (#260).
	Card *cards.Fields
	// LastStatement is a new card's last statement, when it has one (#262):
	// its bill starts from it.
	LastStatement *cards.LastStatement
}

// Changes are the fields to update; nil leaves a field as it is.
type Changes struct {
	Name *string
	Type *sqlc.AccountType
	// ExpectedIncome sets the expected income, or clears it when invalid.
	ExpectedIncome *decimal.NullDecimal
	// Bank sets the bank; "" clears it.
	Bank *string
	// Card sets all of a credit card's fields; only for a card (#260).
	Card *cards.Fields
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
	// BucketSources gives live buckets funded from the account a new source
	// account: bucket ID → account ID.
	BucketSources map[string]string
	// DeleteBuckets are live buckets funded from the account to delete with
	// it (#137). Every such bucket is in exactly one of the two.
	DeleteBuckets []string
}

// Remaining moves the remaining balance: a transfer (TRF) to TransferTo, or,
// with Adjust, a balance adjustment (BLA) to zero. Set exactly one.
type Remaining struct {
	TransferTo string
	Adjust     bool
}

// Savings is what the savings module (#231) does when accounts or their
// buckets go away, inside the same database transaction. The savings package
// implements it (it imports this package's neighbours, not the other way).
type Savings interface {
	// ReleaseBucket releases the money held for the bucket's savings target
	// and deletes the target, if the bucket is one.
	ReleaseBucket(ctx context.Context, tx pgx.Tx, userID, bucketID string) error
	// ReleaseAccount releases every reservation on the account, and the
	// money held for the account's own target, which it deletes.
	ReleaseAccount(ctx context.Context, tx pgx.Tx, userID, accountID string) error
	// ReleaseAccountTarget releases and deletes the account's target only,
	// when the account's type can't be a target any more.
	ReleaseAccountTarget(ctx context.Context, tx pgx.Tx, userID, accountID string) error
}

// Options configures a Service.
type Options struct {
	// Now returns the current time. Defaults to time.Now.
	Now func() time.Time
	// Savings releases savings when an account or bucket goes away. Nil
	// skips it (tests without savings).
	Savings Savings
	// Transactions and Schedules pay a card's bill when it's finalized
	// (#262). Nil without bill payments (tests).
	Transactions *transactions.Service
	Schedules    *schedules.Service
}

// Service manages bank accounts.
type Service struct {
	pool      *pgxpool.Pool
	ledger    *ledger.Ledger
	now       func() time.Time
	savings   Savings
	txs       *transactions.Service
	schedules *schedules.Service
}

// NewService returns a Service that records money movements in l.
func NewService(pool *pgxpool.Pool, l *ledger.Ledger, opts Options) *Service {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Service{pool: pool, ledger: l, now: opts.Now, savings: opts.Savings, txs: opts.Transactions, schedules: opts.Schedules}
}

// TargetTypes are the account types that can be a savings target (#231).
var TargetTypes = []sqlc.AccountType{
	sqlc.AccountTypeSavings, sqlc.AccountTypeBsu, sqlc.AccountTypeFund, sqlc.AccountTypeInvestment,
}

// List returns the user's accounts, sorted by name.
// Flows returns the money in and out of the user's accounts over
// [from, to) (#90); see balance.Flows.
func (s *Service) Flows(ctx context.Context, userID string, from, to time.Time) ([]balance.Flow, error) {
	if !from.Before(to) {
		return nil, fmt.Errorf("%w: the period must end after it starts", ErrInvalid)
	}
	return balance.Flows(ctx, s.pool, userID, from, to)
}

// Stats sums the user's spending, income or balances over a period cut into
// intervals (#121).
func (s *Service) Stats(ctx context.Context, userID string, q stats.Query) (stats.Result, error) {
	return stats.Series(ctx, s.pool, userID, q)
}

// StatsFlows is the buckets' and accounts' money in and out (#126).
func (s *Service) StatsFlows(ctx context.Context, userID string, q stats.FlowsQuery) (stats.FlowsResult, error) {
	return stats.Flows(ctx, s.pool, userID, q)
}

func (s *Service) List(ctx context.Context, userID string) ([]Account, error) {
	q := sqlc.New(s.pool)
	rows, err := q.ListAccounts(ctx, userID)
	if err != nil {
		return nil, err
	}
	money, err := balance.AccountMoney(ctx, s.pool, userID)
	if err != nil {
		return nil, err
	}
	statuses, err := bsu.Statuses(ctx, s.pool, userID, rows, s.now())
	if err != nil {
		return nil, err
	}
	out := make([]Account, len(rows))
	for i, r := range rows {
		out[i] = toAccount(r, money, statuses)
		if err := s.withBill(ctx, q, r, &out[i]); err != nil {
			return nil, err
		}
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
	bank, err := checkBank(n.Bank)
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
	if n.Type == sqlc.AccountTypeBsu && n.Currency != bsu.Currency {
		return Account{}, ErrBSUCurrency
	}
	if (n.Type == sqlc.AccountTypeCreditCard) != (n.Card != nil) {
		return Account{}, fmt.Errorf("%w: a credit card needs its card fields, and only a card has them", ErrInvalid)
	}
	if n.Card != nil {
		if n.Card.Pay == nil {
			p := cards.DefaultPay()
			n.Card.Pay = &p
		}
		if err := cards.CheckFields(*n.Card); err != nil {
			return Account{}, err
		}
	}
	if err := money.Valid(n.OpeningBalance); err != nil {
		return Account{}, fmt.Errorf("%w: opening balance: %w", ErrInvalid, err)
	}
	if n.OpeningAt.IsZero() {
		n.OpeningAt = s.now()
	}

	var out Account
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		if n.Card != nil {
			if err := cards.CheckDefaultAccount(ctx, tx, userID, "", n.Card.DefaultAccountID, n.Currency); err != nil {
				return err
			}
		}
		c := cards.ToColumns(n.Card)
		var row sqlc.BankAccount
		_, err := ids.Insert(ctx, ids.Account, ids.NewAccount, func(ctx context.Context, id string) (bool, error) {
			var err error
			row, err = q.CreateAccount(ctx, sqlc.CreateAccountParams{
				ID: id, UserID: userID, Name: name, Currency: n.Currency, AccountType: n.Type, Bank: bank,
				CardDefaultAccountID: c.DefaultAccountID, CardCreditLimit: c.CreditLimit, CardStatementDay: c.StatementDay,
				CardDueDay: c.DueDay, CardMinimumPayment: c.MinimumPayment,
				CardBillSetUpAt: pgtype.Timestamptz{Time: s.now(), Valid: n.Card != nil},
				CardPayRule:     c.PayRule, CardPayAmount: c.PayAmount, CardPayDaysBefore: c.PayDaysBefore,
				CardPayMode: c.PayMode, CardAutoFinalize: c.AutoFinalize,
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
		if n.Card != nil && n.LastStatement != nil {
			if err := cards.SetUpNew(ctx, tx, userID, row, *n.LastStatement, s.now()); err != nil {
				return err
			}
		}
		out, err = s.get(ctx, tx, userID, row.ID)
		return err
	})
	if err != nil {
		return Account{}, err
	}
	return out, nil
}

// Update changes an account's name, type, expected income or bank.
func (s *Service) Update(ctx context.Context, userID, id string, c Changes) (Account, error) {
	var out Account
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		row, err := q.GetAccountForUpdate(ctx, sqlc.GetAccountForUpdateParams{ID: id, UserID: userID})
		if err != nil {
			return notFound(err, id)
		}
		params := sqlc.UpdateAccountParams{
			ID: id, UserID: userID, Name: row.Name, AccountType: row.AccountType, ExpectedIncome: row.ExpectedIncome, Bank: row.Bank,
			CardDefaultAccountID: row.CardDefaultAccountID, CardCreditLimit: row.CardCreditLimit, CardStatementDay: row.CardStatementDay,
			CardDueDay: row.CardDueDay, CardMinimumPayment: row.CardMinimumPayment,
			CardPayRule: row.CardPayRule, CardPayAmount: row.CardPayAmount, CardPayDaysBefore: row.CardPayDaysBefore,
			CardPayMode: row.CardPayMode, CardAutoFinalize: row.CardAutoFinalize,
		}
		isCard := row.AccountType == sqlc.AccountTypeCreditCard
		if c.Bank != nil {
			if params.Bank, err = checkBank(*c.Bank); err != nil {
				return err
			}
		}
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
			if params.AccountType == sqlc.AccountTypeBsu && row.Currency != bsu.Currency {
				return ErrBSUCurrency
			}
			// A card stays a card, and nothing becomes one (#260).
			if (params.AccountType == sqlc.AccountTypeCreditCard) != isCard {
				return cards.ErrTypeChange
			}
		}
		if c.Card != nil {
			if !isCard {
				return fmt.Errorf("%w: only a credit card has card fields", ErrInvalid)
			}
			// Paying the bill (#262) stays as it was unless given; without a
			// default account, auto-finalize goes off.
			if c.Card.Pay == nil {
				old, _ := cards.FieldsOf(row)
				c.Card.Pay = old.Pay
				if c.Card.DefaultAccountID == "" {
					c.Card.Pay.AutoFinalize = false
				}
			}
			if err := cards.CheckFields(*c.Card); err != nil {
				return err
			}
			if err := cards.CheckDefaultAccount(ctx, tx, userID, id, c.Card.DefaultAccountID, row.Currency); err != nil {
				return err
			}
			cc := cards.ToColumns(c.Card)
			params.CardDefaultAccountID, params.CardCreditLimit, params.CardStatementDay = cc.DefaultAccountID, cc.CreditLimit, cc.StatementDay
			params.CardDueDay, params.CardMinimumPayment = cc.DueDay, cc.MinimumPayment
			params.CardPayRule, params.CardPayAmount, params.CardPayDaysBefore = cc.PayRule, cc.PayAmount, cc.PayDaysBefore
			params.CardPayMode, params.CardAutoFinalize = cc.PayMode, cc.AutoFinalize
		}
		if c.ExpectedIncome != nil {
			if e := *c.ExpectedIncome; e.Valid {
				if err := money.Valid(e.Decimal); err != nil {
					return fmt.Errorf("%w: expected income: %w", ErrInvalid, err)
				}
				if e.Decimal.IsNegative() {
					return fmt.Errorf("%w: the expected income can't be negative", ErrInvalid)
				}
			}
			if isCard && c.ExpectedIncome.Valid {
				return fmt.Errorf("%w: a credit card has no expected income", ErrInvalid)
			}
			params.ExpectedIncome = *c.ExpectedIncome
		}
		if _, err := q.UpdateAccount(ctx, params); err != nil {
			return nameTaken(err)
		}
		// A type that can't be a default account leaves its cards without one
		// (#260).
		if params.AccountType != row.AccountType && !slices.Contains(cards.DefaultAccountTypes, params.AccountType) {
			if err := q.ClearCardDefaultAccount(ctx, sqlc.ClearCardDefaultAccountParams{UserID: userID, CardDefaultAccountID: pgtype.Text{String: id, Valid: true}}); err != nil {
				return err
			}
		}
		// An account that can't be a savings target any more stops being one.
		if s.savings != nil && params.AccountType != row.AccountType && !slices.Contains(TargetTypes, params.AccountType) {
			if err := s.savings.ReleaseAccountTarget(ctx, tx, userID, id); err != nil {
				return err
			}
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

	var out Account
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		if err := s.adjustIn(ctx, tx, userID, id, a); err != nil {
			return err
		}
		var err error
		out, err = s.get(ctx, tx, userID, id)
		return err
	})
	if err != nil {
		return Account{}, err
	}
	return out, nil
}

// adjustIn records the balance adjustment a (its At set) in tx; the caller
// holds the user's lock.
func (s *Service) adjustIn(ctx context.Context, tx pgx.Tx, userID, id string, a Adjustment) error {
	at := a.At.UTC().Truncate(time.Microsecond) // as the ledger stores it
	if _, err := sqlc.New(tx).GetAccountForUpdate(ctx, sqlc.GetAccountForUpdateParams{ID: id, UserID: userID}); err != nil {
		return notFound(err, id)
	}
	// A locked BSU's balance comes from its history setup (#214).
	if err := bsu.Locked(ctx, tx, userID, id); err != nil {
		return err
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
	return nil
}

// Reallocate recalculates the CAF of the buckets funded from the account now,
// as the Money Allocation Routine would (spec §7). Without a trigger, CAF
// stays where it is, so an underfunded account can be reshared by hand, for
// example after a refill. It returns the account.
func (s *Service) Reallocate(ctx context.Context, userID, id string) (Account, error) {
	var out Account
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		if _, err := sqlc.New(tx).GetAccountForUpdate(ctx, sqlc.GetAccountForUpdateParams{ID: id, UserID: userID}); err != nil {
			return notFound(err, id)
		}
		if err := allocation.Run(ctx, tx, userID, []string{id}, true); err != nil {
			return err
		}
		var err error
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
// st.BucketSources or is deleted (st.DeleteBuckets, its funds released
// first), and remaining money is transferred or adjusted away as
// st.Remaining says. Without those it returns *HasBucketsError or
// *BalanceNotZeroError and changes nothing. The account's transactions stay.
func (s *Service) Delete(ctx context.Context, userID, id string, st Settlement) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
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
		for _, b := range st.DeleteBuckets {
			if !slices.Contains(buckets, b) {
				return fmt.Errorf("%w: bucket %s isn't funded from account %s", ErrInvalid, b, id)
			}
			if _, ok := st.BucketSources[b]; ok {
				return fmt.Errorf("%w: bucket %s can't be both moved and deleted", ErrInvalid, b)
			}
		}
		var missing []string
		for _, b := range buckets {
			if _, ok := st.BucketSources[b]; !ok && !slices.Contains(st.DeleteBuckets, b) {
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
		// Buckets can't move to a card (#260).
		if err := cards.NotSource(ctx, tx, userID, slices.Collect(maps.Values(st.BucketSources))...); err != nil {
			return err
		}
		// The money can't go to a locked BSU account (#214); the account
		// itself can be deleted locked.
		if r := st.Remaining; r != nil && r.TransferTo != "" {
			if err := bsu.Locked(ctx, tx, userID, r.TransferTo); err != nil {
				return err
			}
		}

		// The deleted buckets go first, so the money they held is part of
		// what's settled below.
		if err := s.deleteBuckets(ctx, tx, userID, st.DeleteBuckets); err != nil {
			return err
		}
		// Savings held on the account, or for it, are released (#231).
		if s.savings != nil {
			if err := s.savings.ReleaseAccount(ctx, tx, userID, id); err != nil {
				return err
			}
		}

		balances, err := balance.Accounts(ctx, tx, userID)
		if err != nil {
			return err
		}
		// Card debt held on it follows the money (#261): a transfer to an
		// account that isn't a card carries it, else it's released.
		debt, err := balance.CardDebt(ctx, tx, userID)
		if err != nil {
			return err
		}
		holds := debt[id]
		carried := false
		if bal := balances[id]; !bal.IsZero() {
			if carried, err = s.settle(ctx, tx, userID, id, bal, st.Remaining, holds); err != nil {
				return err
			}
		}
		if len(holds) > 0 && !carried {
			e := ledger.Entry{UserID: userID, CreatedBy: userID, Type: sqlc.TransactionTypeCDR, At: s.now()}
			for _, card := range slices.Sorted(maps.Keys(holds)) {
				e.CardLines = append(e.CardLines, ledger.CardLine{CardID: card, AccountID: id, Amount: holds[card].Neg()})
			}
			if _, err := s.ledger.Record(ctx, tx, e); err != nil {
				return fmt.Errorf("release card debt: %w", err)
			}
		}

		for b, to := range st.BucketSources {
			if err := q.SetBucketSource(ctx, sqlc.SetBucketSourceParams{ID: b, UserID: userID, SourceAccountID: to}); err != nil {
				return err
			}
		}
		// The cards it was the default account of have none (#260).
		if err := q.ClearCardDefaultAccount(ctx, sqlc.ClearCardDefaultAccountParams{UserID: userID, CardDefaultAccountID: pgtype.Text{String: id, Valid: true}}); err != nil {
			return err
		}
		if err := q.DeleteAccount(ctx, sqlc.DeleteAccountParams{ID: id, UserID: userID}); err != nil {
			return err
		}
		// The moved buckets are funded from their new accounts now.
		moved := slices.Sorted(maps.Values(st.BucketSources))
		return allocation.Run(ctx, tx, userID, slices.Compact(moved), true)
	})
}

// deleteBuckets deletes buckets with their account, as
// buckets.Service.Delete does one: what's left (TF) is released with a
// bucket adjustment (BUA) first, which the ledger refuses without a usable
// active cycle, and the bucket's transactions stay. Bucket-only lines don't
// change the account's balance.
func (s *Service) deleteBuckets(ctx context.Context, tx pgx.Tx, userID string, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	tf, err := balance.Buckets(ctx, tx, userID)
	if err != nil {
		return err
	}
	q := sqlc.New(tx)
	// Once each, even if the list repeats one.
	for _, b := range slices.Compact(slices.Sorted(slices.Values(ids))) {
		if s.savings != nil {
			if err := s.savings.ReleaseBucket(ctx, tx, userID, b); err != nil {
				return err
			}
		}
		// Before the delete: the ledger refuses lines on deleted buckets.
		if !tf[b].IsZero() {
			if _, err := s.ledger.Record(ctx, tx, ledger.Entry{
				UserID: userID, CreatedBy: userID, Type: sqlc.TransactionTypeBUA, At: s.now(),
				BucketLines: []ledger.BucketLine{{BucketID: b, Amount: tf[b].Neg()}},
			}); err != nil {
				return fmt.Errorf("release target funds of bucket %s: %w", b, err)
			}
		}
		if err := q.DeleteBucket(ctx, sqlc.DeleteBucketParams{ID: b, UserID: userID}); err != nil {
			return err
		}
	}
	return nil
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
// settle settles the money left in account id, and reports whether the card
// debt it holds (holds, by card) was carried along with a transfer.
func (s *Service) settle(ctx context.Context, tx pgx.Tx, userID, id string, bal decimal.Decimal, r *Remaining,
	holds map[string]decimal.Decimal) (bool, error) {
	if r == nil {
		return false, &BalanceNotZeroError{Balance: bal}
	}
	carried := false
	e := ledger.Entry{UserID: userID, CreatedBy: userID, At: s.now()}
	switch {
	case r.Adjust && r.TransferTo == "":
		e.Type = sqlc.TransactionTypeBLA
		e.BankLines = []ledger.BankLine{{AccountID: id, Amount: bal.Neg()}}
	case !r.Adjust && r.TransferTo != "":
		e.Type = sqlc.TransactionTypeTRF
		e.BankLines = []ledger.BankLine{{AccountID: id, Amount: bal.Neg()}, {AccountID: r.TransferTo, Amount: bal}}
		to, err := sqlc.New(tx).GetAccount(ctx, sqlc.GetAccountParams{ID: r.TransferTo, UserID: userID})
		if err != nil {
			return false, notFound(err, r.TransferTo)
		}
		if to.AccountType != sqlc.AccountTypeCreditCard && bal.IsPositive() {
			for _, card := range slices.Sorted(maps.Keys(holds)) {
				e.CardLines = append(e.CardLines,
					ledger.CardLine{CardID: card, AccountID: id, Amount: holds[card].Neg()},
					ledger.CardLine{CardID: card, AccountID: r.TransferTo, Amount: holds[card]})
			}
			carried = len(holds) > 0
		}
	default:
		return false, fmt.Errorf("%w: choose either a transfer or a balance adjustment for the remaining money", ErrInvalid)
	}
	if _, err := s.ledger.Record(ctx, tx, e); err != nil {
		return false, fmt.Errorf("settle remaining money: %w", err)
	}
	return carried, nil
}

func (s *Service) get(ctx context.Context, db sqlc.DBTX, userID, id string) (Account, error) {
	row, err := sqlc.New(db).GetAccount(ctx, sqlc.GetAccountParams{ID: id, UserID: userID})
	if err != nil {
		return Account{}, notFound(err, id)
	}
	money, err := balance.AccountMoney(ctx, db, userID)
	if err != nil {
		return Account{}, err
	}
	statuses, err := bsu.Statuses(ctx, db, userID, []sqlc.BankAccount{row}, s.now())
	if err != nil {
		return Account{}, err
	}
	a := toAccount(row, money, statuses)
	return a, s.withBill(ctx, sqlc.New(db), row, &a)
}

// withBill adds a card's bill as it stands (#262), worked out without fixing.
func (s *Service) withBill(ctx context.Context, q *sqlc.Queries, row sqlc.BankAccount, a *Account) error {
	if a.Card == nil {
		return nil
	}
	bill, err := billOf(ctx, q, row, s.now())
	if err != nil {
		return err
	}
	a.Card.Bill = &bill
	return nil
}

// toAccount builds an account from its row and every account's Money.
func toAccount(r sqlc.BankAccount, all map[string]balance.Money, statuses map[string]bsu.Status) Account {
	m := all[r.ID]
	a := Account{
		ID: r.ID, Name: r.Name, Type: r.AccountType, Currency: r.Currency, Bank: r.Bank,
		Balance: m.Balance, Unallocated: m.Unallocated, Reserved: m.Reserved, ReservedUncovered: m.Uncovered(),
		CardHolds: m.CardHolds, CardDebtUncovered: m.CardUncovered(),
		ExpectedIncome: r.ExpectedIncome, CreatedAt: r.CreatedAt,
	}
	if st, ok := statuses[r.ID]; ok {
		a.BSU = &st
	}
	if st, ok := cards.StatusOf(r, m.Balance); ok {
		st.HeldOn, st.SetAside, st.NotSetAside = cards.Holds(r.ID, all)
		a.Card = &st
	}
	return a
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

// checkBank trims a bank name; "" is none.
func checkBank(bank string) (string, error) {
	bank = strings.TrimSpace(bank)
	if utf8.RuneCountInString(bank) > MaxBank {
		return "", fmt.Errorf("%w: the bank is longer than %d characters", ErrInvalid, MaxBank)
	}
	return bank, nil
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
