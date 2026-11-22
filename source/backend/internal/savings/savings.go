// Package savings manages savings targets and the money held for them
// (#231, spec §8).
//
// A savings target is a Fully manual bucket, or a savings, BSU, fund or
// investment account, with a goal. Money for savings stays in the account
// it's in (its source account) until it's moved, and is reserved there: the
// ledger records it as savings lines, and an account's unallocated money
// leaves out what's reserved (balance.Money). The buckets are funded first;
// reservations take only what's left.
//
//   - Add reserves unallocated money for a target (SVR). For a bucket target
//     funded from the same account it goes straight into the bucket (SVB with
//     only a bucket line), since nothing needs moving.
//   - Done records held funds as moved: a transfer (TRF) to an account target,
//     or an SVB into a bucket target, with bank lines when the bucket is on
//     another account.
//   - Clear gives held funds back to unallocated (SVC).
//
// When a target goes away (deleted, or its bucket or account deleted or no
// longer eligible), its held funds are released in the same step.
package savings

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/allocation"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/balance"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
)

// Errors. They wrap a message that says what is wrong.
var (
	// ErrNotFound means the target, bucket or account doesn't exist, isn't
	// the user's or is deleted.
	ErrNotFound = errors.New("not found")
	// ErrInvalid means a value breaks a rule.
	ErrInvalid = errors.New("invalid")
	// ErrAlreadyTarget means the bucket or account is a savings target
	// already.
	ErrAlreadyTarget = errors.New("this is already a savings target")
	// ErrNotFullyManual means the bucket isn't Fully manual.
	ErrNotFullyManual = errors.New("only a Fully manual bucket can be a savings target")
	// ErrWrongAccountType means the account isn't a savings, BSU, fund or
	// investment account.
	ErrWrongAccountType = errors.New("only a savings, BSU, fund or investment account can be a savings target")
	// ErrGoalAboveCapacity means a bucket target's goal is above its fixed
	// capacity.
	ErrGoalAboveCapacity = errors.New("the goal is above the bucket's capacity")
	// ErrAboveCapacity means the bucket's funds would go above its fixed
	// capacity.
	ErrAboveCapacity = errors.New("the bucket can't hold more")
	// ErrCurrencyMismatch means the account isn't in the target's currency.
	ErrCurrencyMismatch = errors.New("the account isn't in the target's currency")
	// ErrNotEnoughUnallocated is wrapped by NotEnoughUnallocatedError.
	ErrNotEnoughUnallocated = errors.New("not enough unallocated money")
	// ErrNotEnoughHeld is wrapped by NotEnoughHeldError.
	ErrNotEnoughHeld = errors.New("not that much is held")
)

// NotEnoughUnallocatedError means the account has only Available
// unallocated money to reserve.
type NotEnoughUnallocatedError struct{ Available decimal.Decimal }

func (e *NotEnoughUnallocatedError) Error() string {
	return fmt.Sprintf("%v: %s is unallocated", ErrNotEnoughUnallocated, e.Available.StringFixed(money.Places))
}

func (e *NotEnoughUnallocatedError) Unwrap() error { return ErrNotEnoughUnallocated }

// NotEnoughHeldError means only Held is held for the target on the account
// (at the time asked for).
type NotEnoughHeldError struct{ Held decimal.Decimal }

func (e *NotEnoughHeldError) Error() string {
	return fmt.Sprintf("%v: %s is held", ErrNotEnoughHeld, e.Held.StringFixed(money.Places))
}

func (e *NotEnoughHeldError) Unwrap() error { return ErrNotEnoughHeld }

// Limits on the free-text fields.
const (
	MaxName = 100
	MaxNote = 500
)

// Target is a savings target with its progress.
type Target struct {
	ID string
	// Name is the target's own name, else its bucket's or account's.
	Name string
	// CustomName is the target's own name, "" when it uses its bucket's or
	// account's.
	CustomName string
	// BucketID or AccountID is what the target is.
	BucketID  string
	AccountID string
	// BucketAccountID is a bucket target's source account.
	BucketAccountID string
	Currency        string
	Goal            decimal.Decimal
	Note            string
	// Current is the bucket's TF or the account's balance.
	Current decimal.Decimal
	// Held is the money held for the target, per source account.
	Held       []Held
	CreatedAt  time.Time
	ModifiedAt time.Time
}

// HeldTotal is what's held for the target on all accounts.
func (t Target) HeldTotal() decimal.Decimal {
	sum := decimal.Zero
	for _, h := range t.Held {
		sum = sum.Add(h.Amount)
	}
	return sum
}

// Held is money held for a target on one source account.
type Held struct {
	AccountID string
	Amount    decimal.Decimal
	// Covered is the part of Amount the account's balance covers, after its
	// buckets (spec §7).
	Covered decimal.Decimal
}

// New describes a target to create: a bucket or an account.
type New struct {
	BucketID  string
	AccountID string
	// Name is optional: "" uses the bucket's or account's name.
	Name string
	Goal decimal.Decimal
	Note string
}

// Changes are the fields to change; nil leaves a field as it is. An empty
// Name goes back to the bucket's or account's name.
type Changes struct {
	Name *string
	Goal *decimal.Decimal
	Note *string
}

// Done records held funds as moved to the target.
type Done struct {
	// AccountID is the source account the funds are held on.
	AccountID string
	Amount    decimal.Decimal
	// At is when the money was moved; zero means now. It can't be in the
	// future, nor before the funds were held.
	At          time.Time
	Description string
}

// Options configures a Service.
type Options struct {
	// Now returns the current time. Defaults to time.Now.
	Now func() time.Time
}

// Service manages savings targets.
type Service struct {
	pool   *pgxpool.Pool
	ledger *ledger.Ledger
	now    func() time.Time
}

var _ accounts.Savings = (*Service)(nil)

// NewService returns a Service that records money movements in l.
func NewService(pool *pgxpool.Pool, l *ledger.Ledger, opts Options) *Service {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Service{pool: pool, ledger: l, now: opts.Now}
}

// List returns the user's targets, oldest first.
func (s *Service) List(ctx context.Context, userID string) ([]Target, error) {
	return list(ctx, s.pool, userID)
}

// Get returns one of the user's targets.
func (s *Service) Get(ctx context.Context, userID, id string) (Target, error) {
	return get(ctx, s.pool, userID, id)
}

// Create creates a target.
func (s *Service) Create(ctx context.Context, userID string, n New) (Target, error) {
	if (n.BucketID == "") == (n.AccountID == "") {
		return Target{}, fmt.Errorf("%w: a target is either a bucket or an account", ErrInvalid)
	}
	name, err := checkName(n.Name)
	if err != nil {
		return Target{}, err
	}
	note, err := checkNote(n.Note)
	if err != nil {
		return Target{}, err
	}
	if err := checkAmount("goal", n.Goal); err != nil {
		return Target{}, err
	}
	var out Target
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		params := sqlc.CreateSavingsHolderParams{
			UserID: userID, Kind: sqlc.SavingsHolderKindTarget, Name: name,
			Goal: decimal.NewNullDecimal(n.Goal), Note: note,
		}
		if n.BucketID != "" {
			b, err := q.GetBucketForUpdate(ctx, sqlc.GetBucketForUpdateParams{ID: n.BucketID, UserID: userID})
			if err != nil {
				return notFound(err, "bucket", n.BucketID)
			}
			if b.RefillMode != sqlc.RefillModeFullyManual {
				return ErrNotFullyManual
			}
			if err := checkGoal(b, n.Goal); err != nil {
				return err
			}
			if _, err := q.GetTargetOfBucket(ctx, pgtype.Text{String: b.ID, Valid: true}); err == nil {
				return ErrAlreadyTarget
			} else if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			params.BucketID = pgtype.Text{String: b.ID, Valid: true}
		} else {
			a, err := q.GetAccountForUpdate(ctx, sqlc.GetAccountForUpdateParams{ID: n.AccountID, UserID: userID})
			if err != nil {
				return notFound(err, "account", n.AccountID)
			}
			if !slices.Contains(accounts.TargetTypes, a.AccountType) {
				return ErrWrongAccountType
			}
			if _, err := q.GetTargetOfAccount(ctx, pgtype.Text{String: a.ID, Valid: true}); err == nil {
				return ErrAlreadyTarget
			} else if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			params.AccountID = pgtype.Text{String: a.ID, Valid: true}
		}
		id, err := ids.Insert(ctx, ids.SavingsHolder, func() string { return ids.NewSavingsHolder(userID) },
			func(ctx context.Context, id string) (bool, error) {
				params.ID = id
				_, err := q.CreateSavingsHolder(ctx, params)
				return ids.Inserted(err)
			})
		if err != nil {
			return err
		}
		out, err = get(ctx, tx, userID, id)
		return err
	})
	if err != nil {
		return Target{}, err
	}
	return out, nil
}

// Update changes a target's name, goal or note.
func (s *Service) Update(ctx context.Context, userID, id string, c Changes) (Target, error) {
	var out Target
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		t, err := lockTarget(ctx, tx, userID, id)
		if err != nil {
			return err
		}
		p := sqlc.UpdateSavingsTargetParams{ID: id, UserID: userID, Name: t.holder.Name, Goal: t.holder.Goal, Note: t.holder.Note}
		if c.Name != nil {
			if p.Name, err = checkName(*c.Name); err != nil {
				return err
			}
		}
		if c.Note != nil {
			if p.Note, err = checkNote(*c.Note); err != nil {
				return err
			}
		}
		if c.Goal != nil {
			if err := checkAmount("goal", *c.Goal); err != nil {
				return err
			}
			if t.bucket != nil {
				if err := checkGoal(*t.bucket, *c.Goal); err != nil {
					return err
				}
			}
			p.Goal = decimal.NewNullDecimal(*c.Goal)
		}
		if _, err := sqlc.New(tx).UpdateSavingsTarget(ctx, p); err != nil {
			return err
		}
		out, err = get(ctx, tx, userID, id)
		return err
	})
	if err != nil {
		return Target{}, err
	}
	return out, nil
}

// Delete deletes a target after releasing its held funds (SVC), so they're
// unallocated again. Its transactions stay.
func (s *Service) Delete(ctx context.Context, userID, id string) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		t, err := lockTarget(ctx, tx, userID, id)
		if err != nil {
			return err
		}
		return s.retire(ctx, tx, userID, t.holder.ID)
	})
}

// Add reserves amount of the account's unallocated money for the target.
// It's refused above what's unallocated (*NotEnoughUnallocatedError). For a
// bucket target funded from this account, the money goes into the bucket at
// once (an SVB, which needs an active cycle and room below a fixed capacity);
// otherwise it's held (SVR). The goal doesn't limit it.
func (s *Service) Add(ctx context.Context, userID, id, accountID string, amount decimal.Decimal) (Target, error) {
	if err := checkAmount("amount", amount); err != nil {
		return Target{}, err
	}
	var out Target
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		t, err := lockTarget(ctx, tx, userID, id)
		if err != nil {
			return err
		}
		if err := s.checkSource(ctx, tx, userID, t, accountID); err != nil {
			return err
		}
		if t.account != nil && t.account.ID == accountID {
			return fmt.Errorf("%w: the money is in the target account already", ErrInvalid)
		}
		m, err := balance.AccountMoney(ctx, tx, userID)
		if err != nil {
			return err
		}
		if free := m[accountID].Unallocated; amount.GreaterThan(free) {
			return &NotEnoughUnallocatedError{Available: decimal.Max(free, decimal.Zero)}
		}
		e := ledger.Entry{UserID: userID, CreatedBy: userID, At: s.now()}
		if t.bucket != nil && t.bucket.SourceAccountID == accountID {
			if err := checkRoom(ctx, tx, userID, *t.bucket, amount); err != nil {
				return err
			}
			e.Type = sqlc.TransactionTypeSVB
			e.BucketLines = []ledger.BucketLine{{BucketID: t.bucket.ID, Amount: amount}}
		} else {
			e.Type = sqlc.TransactionTypeSVR
			e.SavingsLines = []ledger.SavingsLine{{HolderID: id, AccountID: accountID, Amount: amount}}
		}
		if _, err := s.ledger.Record(ctx, tx, e); err != nil {
			return err
		}
		out, err = get(ctx, tx, userID, id)
		return err
	})
	if err != nil {
		return Target{}, err
	}
	return out, nil
}

// Done records held funds as moved to the target: a transfer (TRF) to an
// account target, or an SVB into a bucket target (with the transfer's bank
// lines when the bucket is on another account; it needs an active cycle that
// contains d.At, and room below a fixed capacity). Each has a savings line
// that takes the amount off what's held. Less than what's held leaves the
// rest held.
func (s *Service) Done(ctx context.Context, userID, id string, d Done) (Target, error) {
	if err := checkAmount("amount", d.Amount); err != nil {
		return Target{}, err
	}
	now := s.now()
	if d.At.IsZero() {
		d.At = now
	}
	if d.At.After(now) {
		return Target{}, fmt.Errorf("%w: the time can't be in the future", ErrInvalid)
	}
	var out Target
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		t, err := lockTarget(ctx, tx, userID, id)
		if err != nil {
			return err
		}
		if err := checkHeld(ctx, tx, id, d.AccountID, d.Amount, now, d.At); err != nil {
			return err
		}
		e := ledger.Entry{
			UserID: userID, CreatedBy: userID, At: d.At, Description: d.Description,
			SavingsLines: []ledger.SavingsLine{{HolderID: id, AccountID: d.AccountID, Amount: d.Amount.Neg()}},
		}
		if t.account != nil {
			e.Type = sqlc.TransactionTypeTRF
			e.BankLines = []ledger.BankLine{
				{AccountID: d.AccountID, Amount: d.Amount.Neg()},
				{AccountID: t.account.ID, Amount: d.Amount},
			}
		} else {
			if err := checkRoom(ctx, tx, userID, *t.bucket, d.Amount); err != nil {
				return err
			}
			e.Type = sqlc.TransactionTypeSVB
			e.BucketLines = []ledger.BucketLine{{BucketID: t.bucket.ID, Amount: d.Amount}}
			if to := t.bucket.SourceAccountID; to != d.AccountID {
				e.BankLines = []ledger.BankLine{
					{AccountID: d.AccountID, Amount: d.Amount.Neg()},
					{AccountID: to, Amount: d.Amount},
				}
			}
		}
		if _, err := s.ledger.Record(ctx, tx, e); err != nil {
			return err
		}
		out, err = get(ctx, tx, userID, id)
		return err
	})
	if err != nil {
		return Target{}, err
	}
	return out, nil
}

// Clear gives amount of the funds held for the target on the account back to
// unallocated (SVC).
func (s *Service) Clear(ctx context.Context, userID, id, accountID string, amount decimal.Decimal) (Target, error) {
	if err := checkAmount("amount", amount); err != nil {
		return Target{}, err
	}
	var out Target
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		if _, err := lockTarget(ctx, tx, userID, id); err != nil {
			return err
		}
		now := s.now()
		if err := checkHeld(ctx, tx, id, accountID, amount, now, now); err != nil {
			return err
		}
		if _, err := s.ledger.Record(ctx, tx, ledger.Entry{
			UserID: userID, CreatedBy: userID, Type: sqlc.TransactionTypeSVC, At: now,
			SavingsLines: []ledger.SavingsLine{{HolderID: id, AccountID: accountID, Amount: amount.Neg()}},
		}); err != nil {
			return err
		}
		var err error
		out, err = get(ctx, tx, userID, id)
		return err
	})
	if err != nil {
		return Target{}, err
	}
	return out, nil
}

// ReleaseBucket releases the money held for the bucket's target and deletes
// the target, if the bucket is one. It's the buckets service's ReleaseSavings
// hook, run when the bucket is deleted or stops being Fully manual, and the
// accounts service's when a bucket is deleted with its account.
func (s *Service) ReleaseBucket(ctx context.Context, tx pgx.Tx, userID, bucketID string) error {
	h, err := sqlc.New(tx).GetTargetOfBucket(ctx, pgtype.Text{String: bucketID, Valid: true})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return s.retire(ctx, tx, userID, h.ID)
}

// ReleaseAccountTarget releases the money held for the account's target and
// deletes the target, if the account is one.
func (s *Service) ReleaseAccountTarget(ctx context.Context, tx pgx.Tx, userID, accountID string) error {
	h, err := sqlc.New(tx).GetTargetOfAccount(ctx, pgtype.Text{String: accountID, Valid: true})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return s.retire(ctx, tx, userID, h.ID)
}

// ReleaseAccount is run before an account is deleted: its own target goes,
// and every reservation on it is released, whoever it's for.
func (s *Service) ReleaseAccount(ctx context.Context, tx pgx.Tx, userID, accountID string) error {
	if err := s.ReleaseAccountTarget(ctx, tx, userID, accountID); err != nil {
		return err
	}
	rows, err := sqlc.New(tx).SavingsHeldOnAccount(ctx, accountID)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if err := s.release(ctx, tx, userID, r.HolderID, accountID, r.Held); err != nil {
			return err
		}
	}
	return nil
}

// retire releases everything held for the holder and deletes it, with its
// rules.
func (s *Service) retire(ctx context.Context, tx pgx.Tx, userID, holderID string) error {
	q := sqlc.New(tx)
	rows, err := q.SavingsHeld(ctx, userID)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if r.HolderID != holderID {
			continue
		}
		if err := s.release(ctx, tx, userID, holderID, r.AccountID, r.Held); err != nil {
			return err
		}
	}
	// Its distributor rules go with it (#232).
	if err := q.DeleteRulesOfTarget(ctx, holderID); err != nil {
		return err
	}
	return q.DeleteSavingsHolder(ctx, sqlc.DeleteSavingsHolderParams{ID: holderID, UserID: userID})
}

// release records an SVC that takes held off what the holder holds on the
// account.
func (s *Service) release(ctx context.Context, tx pgx.Tx, userID, holderID, accountID string, held decimal.Decimal) error {
	if held.IsZero() {
		return nil
	}
	if _, err := s.ledger.Record(ctx, tx, ledger.Entry{
		UserID: userID, CreatedBy: userID, Type: sqlc.TransactionTypeSVC, At: s.now(),
		SavingsLines: []ledger.SavingsLine{{HolderID: holderID, AccountID: accountID, Amount: held.Neg()}},
	}); err != nil {
		return fmt.Errorf("release savings held on account %s: %w", accountID, err)
	}
	return nil
}

// locked is a target with what it is, locked for the transaction.
type locked struct {
	holder   sqlc.SavingsHolder
	bucket   *sqlc.Bucket
	account  *sqlc.BankAccount
	currency string
}

func lockTarget(ctx context.Context, tx pgx.Tx, userID, id string) (locked, error) {
	q := sqlc.New(tx)
	h, err := q.GetSavingsHolderForUpdate(ctx, sqlc.GetSavingsHolderForUpdateParams{ID: id, UserID: userID})
	if err != nil || h.Kind != sqlc.SavingsHolderKindTarget {
		if err == nil {
			err = pgx.ErrNoRows
		}
		return locked{}, notFound(err, "savings target", id)
	}
	t := locked{holder: h}
	if h.BucketID.Valid {
		b, err := q.GetBucketForUpdate(ctx, sqlc.GetBucketForUpdateParams{ID: h.BucketID.String, UserID: userID})
		if err != nil {
			return locked{}, notFound(err, "bucket", h.BucketID.String)
		}
		a, err := q.GetAccount(ctx, sqlc.GetAccountParams{ID: b.SourceAccountID, UserID: userID})
		if err != nil {
			return locked{}, notFound(err, "account", b.SourceAccountID)
		}
		t.bucket, t.currency = &b, a.Currency
	} else {
		a, err := q.GetAccountForUpdate(ctx, sqlc.GetAccountForUpdateParams{ID: h.AccountID.String, UserID: userID})
		if err != nil {
			return locked{}, notFound(err, "account", h.AccountID.String)
		}
		t.account, t.currency = &a, a.Currency
	}
	return t, nil
}

// checkSource checks that money for t can be held on the account: one of the
// user's live accounts, in t's currency.
func (s *Service) checkSource(ctx context.Context, tx pgx.Tx, userID string, t locked, accountID string) error {
	a, err := sqlc.New(tx).GetAccount(ctx, sqlc.GetAccountParams{ID: accountID, UserID: userID})
	if err != nil {
		return notFound(err, "account", accountID)
	}
	if a.Currency != t.currency {
		return fmt.Errorf("%w: %s is in %s, the target in %s", ErrCurrencyMismatch, accountID, a.Currency, t.currency)
	}
	return nil
}

// checkHeld checks that at least amount is held for the holder on the
// account now, and was at the time at.
func checkHeld(ctx context.Context, tx pgx.Tx, holderID, accountID string, amount decimal.Decimal, now, at time.Time) error {
	q := sqlc.New(tx)
	held, err := q.SavingsHeldAt(ctx, sqlc.SavingsHeldAtParams{HolderID: holderID, AccountID: accountID, At: now})
	if err != nil {
		return err
	}
	if at.Before(now) {
		then, err := q.SavingsHeldAt(ctx, sqlc.SavingsHeldAtParams{HolderID: holderID, AccountID: accountID, At: at})
		if err != nil {
			return err
		}
		held = decimal.Min(held, then)
	}
	if amount.GreaterThan(held) {
		return &NotEnoughHeldError{Held: decimal.Max(held, decimal.Zero)}
	}
	return nil
}

// checkRoom checks that the bucket's TF can grow by amount without going
// above a fixed capacity.
func checkRoom(ctx context.Context, tx pgx.Tx, userID string, b sqlc.Bucket, amount decimal.Decimal) error {
	tf, err := balance.Buckets(ctx, tx, userID)
	if err != nil {
		return err
	}
	if c := buckets.Capacity(b); c.Valid && tf[b.ID].Add(amount).GreaterThan(c.Decimal) {
		room := decimal.Max(c.Decimal.Sub(tf[b.ID]), decimal.Zero)
		return fmt.Errorf("%w: it has room for %s more", ErrAboveCapacity, room.StringFixed(money.Places))
	}
	return nil
}

// checkGoal checks a bucket target's goal against its fixed capacity.
func checkGoal(b sqlc.Bucket, goal decimal.Decimal) error {
	if c := buckets.Capacity(b); c.Valid && goal.GreaterThan(c.Decimal) {
		return fmt.Errorf("%w (%s)", ErrGoalAboveCapacity, c.Decimal.StringFixed(money.Places))
	}
	return nil
}

func checkAmount(what string, d decimal.Decimal) error {
	if err := money.Valid(d); err != nil {
		return fmt.Errorf("%w: %s: %w", ErrInvalid, what, err)
	}
	if !d.IsPositive() {
		return fmt.Errorf("%w: the %s must be above 0", ErrInvalid, what)
	}
	return nil
}

func checkName(name string) (pgtype.Text, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return pgtype.Text{}, nil
	}
	if utf8.RuneCountInString(name) > MaxName {
		return pgtype.Text{}, fmt.Errorf("%w: the name is longer than %d characters", ErrInvalid, MaxName)
	}
	return pgtype.Text{String: name, Valid: true}, nil
}

func checkNote(note string) (string, error) {
	note = ledger.CleanDescription(note)
	if utf8.RuneCountInString(note) > MaxNote {
		return "", fmt.Errorf("%w: the note is longer than %d characters", ErrInvalid, MaxNote)
	}
	return note, nil
}

func notFound(err error, what, id string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: %s %s", ErrNotFound, what, id)
	}
	return err
}

func get(ctx context.Context, db sqlc.DBTX, userID, id string) (Target, error) {
	all, err := list(ctx, db, userID)
	if err != nil {
		return Target{}, err
	}
	i := slices.IndexFunc(all, func(t Target) bool { return t.ID == id })
	if i < 0 {
		return Target{}, fmt.Errorf("%w: savings target %s", ErrNotFound, id)
	}
	return all[i], nil
}

func list(ctx context.Context, db sqlc.DBTX, userID string) ([]Target, error) {
	q := sqlc.New(db)
	rows, err := q.ListSavingsTargets(ctx, userID)
	if err != nil {
		return nil, err
	}
	held, err := q.SavingsHeld(ctx, userID)
	if err != nil {
		return nil, err
	}
	money, err := balance.AccountMoney(ctx, db, userID)
	if err != nil {
		return nil, err
	}
	tf, err := balance.Buckets(ctx, db, userID)
	if err != nil {
		return nil, err
	}
	covered := coverage(held, money)

	out := make([]Target, len(rows))
	for i, r := range rows {
		t := Target{
			ID: r.ID, Name: r.SourceName, CustomName: r.Name.String,
			BucketID: r.BucketID.String, AccountID: r.AccountID.String, BucketAccountID: r.BucketAccountID,
			Currency: r.Currency, Goal: r.Goal.Decimal, Note: r.Note,
			CreatedAt: r.CreatedAt, ModifiedAt: r.ModifiedAt,
		}
		if r.Name.Valid {
			t.Name = r.Name.String
		}
		if t.BucketID != "" {
			t.Current = tf[t.BucketID]
		} else {
			t.Current = money[t.AccountID].Balance
		}
		for _, h := range held {
			if h.HolderID == r.ID {
				t.Held = append(t.Held, Held{AccountID: h.AccountID, Amount: h.Held, Covered: covered[h.HolderID+" "+h.AccountID]})
			}
		}
		out[i] = t
	}
	return out, nil
}

// coverage splits what each account covers of its reservations among the
// holders, by what they hold, as the allocation routine splits money among
// buckets (largest remainder), keyed by holder and account.
func coverage(held []sqlc.SavingsHeldRow, m map[string]balance.Money) map[string]decimal.Decimal {
	byAccount := map[string][]allocation.Bucket{}
	for _, h := range held {
		byAccount[h.AccountID] = append(byAccount[h.AccountID], allocation.Bucket{ID: h.HolderID, TF: h.Held, Importance: 1})
	}
	out := make(map[string]decimal.Decimal, len(held))
	for account, holders := range byAccount {
		mon := m[account]
		if mon.Uncovered().IsZero() {
			for _, h := range holders {
				out[h.ID+" "+account] = decimal.Max(h.TF, decimal.Zero)
			}
			continue
		}
		for id, c := range allocation.Allocate(mon.Covered, holders) {
			out[id+" "+account] = c
		}
	}
	return out
}
