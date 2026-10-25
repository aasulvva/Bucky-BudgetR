// Package buckets manages buckets (spec §4): creating one with its opening
// funds, changing its settings and deleting it.
//
// Every change that moves money goes through the ledger in the same database
// transaction as the bucket change, so a bucket never exists without its
// opening funds, and is never deleted with target funds left in it.
package buckets

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/allocation"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/balance"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
)

var (
	// ErrNotFound means the bucket doesn't exist, is deleted or belongs to
	// another user.
	ErrNotFound = errors.New("not found")
	// ErrInvalid means the input breaks a rule. The message says which.
	ErrInvalid = errors.New("invalid")
	// ErrNameTaken means the user already has a live bucket with the name.
	ErrNameTaken = errors.New("a bucket with this name already exists")
	// ErrCurrencyMismatch means the new source account has another currency
	// than the old one.
	ErrCurrencyMismatch = errors.New("the accounts have different currencies")
)

const (
	// MaxName is the longest bucket name, in characters.
	MaxName = 100
	// DefaultImportance is a new bucket's importance when none is given.
	DefaultImportance = 5
	// MaxMultiplier is the largest capacity multiplier the database stores.
	MaxMultiplier = 9999.99
)

// Bucket is a bucket with its currency, its Target Funds (TF, from the
// ledger) and its calculated Bucket Capacity (BC).
type Bucket struct {
	sqlc.Bucket
	Currency    string
	TargetFunds decimal.Decimal
	Capacity    decimal.Decimal
}

// New describes a bucket to create. Zero values get the defaults.
type New struct {
	Name            string
	SourceAccountID string
	RefillAmount    decimal.Decimal
	// CapMode defaults to multiplier.
	CapMode sqlc.BucketCapMode
	// CapMultiplier is for the multiplier mode and defaults to 1.
	CapMultiplier decimal.Decimal
	// CapAmount is for the fixed mode. It is raised to RefillAmount if lower.
	CapAmount decimal.Decimal
	KeepFunds bool
	// RefillMode defaults to the user's default_refill_mode preference, or
	// auto.
	RefillMode sqlc.RefillMode
	// OverflowDestination defaults to unallocated, the only one available
	// until the savings module (§8).
	OverflowDestination sqlc.OverflowDestination
	Priority            bool
	// Importance is 1–10 and defaults to DefaultImportance.
	Importance int
	// OpeningFunds is recorded as an Opening Funds (OPF) transaction now.
	// Zero records nothing; otherwise the user needs an active cycle.
	OpeningFunds decimal.Decimal
}

// Changes are the fields to update; nil leaves a field as it is.
type Changes struct {
	Name *string
	// SourceAccountID must be an account in the same currency. Changing it
	// resets CAF, so the allocation routine funds the bucket from the new
	// account.
	SourceAccountID     *string
	RefillAmount        *decimal.Decimal
	CapMode             *sqlc.BucketCapMode
	CapMultiplier       *decimal.Decimal
	CapAmount           *decimal.Decimal
	KeepFunds           *bool
	RefillMode          *sqlc.RefillMode
	OverflowDestination *sqlc.OverflowDestination
	Priority            *bool
	Importance          *int
}

// Options configures a Service.
type Options struct {
	// Now returns the current time. Defaults to time.Now.
	Now func() time.Time
}

// Service manages buckets.
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

// List returns the user's buckets, sorted by name.
func (s *Service) List(ctx context.Context, userID string) ([]Bucket, error) {
	rows, err := sqlc.New(s.pool).ListBuckets(ctx, userID)
	if err != nil {
		return nil, err
	}
	tf, err := balance.Buckets(ctx, s.pool, userID)
	if err != nil {
		return nil, err
	}
	out := make([]Bucket, len(rows))
	for i, r := range rows {
		out[i] = toBucket(r.Bucket, r.Currency, tf[r.Bucket.ID])
	}
	return out, nil
}

// Get returns one of the user's buckets.
func (s *Service) Get(ctx context.Context, userID, id string) (Bucket, error) {
	return s.get(ctx, s.pool, userID, id)
}

// Create creates a bucket and its opening funds.
func (s *Service) Create(ctx context.Context, userID string, n New) (Bucket, error) {
	name, err := checkName(n.Name)
	if err != nil {
		return Bucket{}, err
	}
	if n.CapMode == "" {
		n.CapMode = sqlc.BucketCapModeMultiplier
	}
	if n.CapMultiplier.IsZero() {
		n.CapMultiplier = decimal.NewFromInt(1)
	}
	if n.OverflowDestination == "" {
		n.OverflowDestination = sqlc.OverflowDestinationUnallocated
	}
	if n.Importance == 0 {
		n.Importance = DefaultImportance
	}
	if err := money.Valid(n.OpeningFunds); err != nil {
		return Bucket{}, fmt.Errorf("%w: opening funds: %w", ErrInvalid, err)
	}
	if n.OpeningFunds.IsNegative() {
		return Bucket{}, fmt.Errorf("%w: the opening funds are negative", ErrInvalid)
	}

	var out Bucket
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		// The source must be a live account of the user.
		if _, err := sourceCurrency(ctx, q, userID, n.SourceAccountID); err != nil {
			return err
		}
		if n.RefillMode == "" {
			pref, err := q.GetDefaultRefillMode(ctx, userID)
			if err != nil {
				return err
			}
			n.RefillMode = sqlc.RefillMode(pref)
			if !n.RefillMode.Valid() {
				n.RefillMode = sqlc.RefillModeAuto
			}
		}
		st := settings{
			RefillAmount: n.RefillAmount, CapMode: n.CapMode, KeepFunds: n.KeepFunds,
			RefillMode: n.RefillMode, OverflowDestination: n.OverflowDestination,
			Priority: n.Priority, Importance: n.Importance,
		}
		if n.CapMode == sqlc.BucketCapModeFixed {
			st.CapAmount = decimal.NewNullDecimal(n.CapAmount)
		} else {
			st.CapMultiplier = decimal.NewNullDecimal(n.CapMultiplier)
		}
		if err := st.check(); err != nil {
			return err
		}

		var row sqlc.Bucket
		_, err = ids.Insert(ctx, ids.Bucket, func() string { return ids.NewBucket(userID) }, func(ctx context.Context, id string) (bool, error) {
			var err error
			row, err = q.CreateBucket(ctx, sqlc.CreateBucketParams{
				ID: id, UserID: userID, Name: name, SourceAccountID: n.SourceAccountID,
				RefillAmount: st.RefillAmount, CapMode: st.CapMode, CapMultiplier: st.CapMultiplier, CapAmount: st.CapAmount,
				KeepFunds: st.KeepFunds, RefillMode: st.RefillMode, OverflowDestination: st.OverflowDestination,
				Priority: st.Priority, Importance: st.dbImportance,
			})
			return ids.Inserted(err)
		})
		if err != nil {
			return nameTaken(err)
		}
		if !n.OpeningFunds.IsZero() {
			if _, err := s.ledger.Record(ctx, tx, ledger.Entry{
				UserID: userID, CreatedBy: userID, Type: sqlc.TransactionTypeOPF, At: s.now(),
				BucketLines: []ledger.BucketLine{{BucketID: row.ID, Amount: n.OpeningFunds}},
			}); err != nil {
				return fmt.Errorf("record opening funds: %w", err)
			}
		}
		// A new bucket changes how its account's money is split.
		if err := allocation.Run(ctx, tx, userID, []string{n.SourceAccountID}, true); err != nil {
			return err
		}
		out, err = s.get(ctx, tx, userID, row.ID)
		return err
	})
	if err != nil {
		return Bucket{}, err
	}
	return out, nil
}

// Update changes a bucket's settings.
func (s *Service) Update(ctx context.Context, userID, id string, c Changes) (Bucket, error) {
	var out Bucket
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		row, err := q.GetBucketForUpdate(ctx, sqlc.GetBucketForUpdateParams{ID: id, UserID: userID})
		if err != nil {
			return notFound(err, id)
		}
		p := sqlc.UpdateBucketParams{ID: id, UserID: userID, Name: row.Name, SourceAccountID: row.SourceAccountID, Caf: row.Caf}
		if c.Name != nil {
			if p.Name, err = checkName(*c.Name); err != nil {
				return err
			}
		}
		if c.SourceAccountID != nil && *c.SourceAccountID != row.SourceAccountID {
			if err := checkNewSource(ctx, q, userID, row.SourceAccountID, *c.SourceAccountID); err != nil {
				return err
			}
			p.SourceAccountID = *c.SourceAccountID
			p.Caf = decimal.Zero
		}

		st := settings{
			RefillAmount: row.RefillAmount, CapMode: row.CapMode, CapMultiplier: row.CapMultiplier, CapAmount: row.CapAmount,
			KeepFunds: row.KeepFunds, RefillMode: row.RefillMode, OverflowDestination: row.OverflowDestination,
			Priority: row.Priority, Importance: int(row.Importance),
		}
		if err := st.apply(c); err != nil {
			return err
		}
		if err := st.check(); err != nil {
			return err
		}
		p.RefillAmount, p.CapMode, p.CapMultiplier, p.CapAmount = st.RefillAmount, st.CapMode, st.CapMultiplier, st.CapAmount
		p.KeepFunds, p.RefillMode, p.OverflowDestination = st.KeepFunds, st.RefillMode, st.OverflowDestination
		p.Priority, p.Importance = st.Priority, st.dbImportance
		if err := q.UpdateBucket(ctx, p); err != nil {
			return nameTaken(err)
		}
		// Settings that change how the money is split take effect at once.
		if p.SourceAccountID != row.SourceAccountID || p.Priority != row.Priority || p.Importance != row.Importance {
			if err := allocation.Run(ctx, tx, userID, compact(row.SourceAccountID, p.SourceAccountID), true); err != nil {
				return err
			}
		}
		out, err = s.get(ctx, tx, userID, id)
		return err
	})
	if err != nil {
		return Bucket{}, err
	}
	return out, nil
}

// Delete soft-deletes a bucket. Its remaining TF is released first with a
// Bucket Adjustment (BUA) to zero, so the money becomes unallocated in the
// source account; that needs an active cycle unless TF is already zero. The
// bucket's transactions stay.
func (s *Service) Delete(ctx context.Context, userID, id string) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		row, err := q.GetBucketForUpdate(ctx, sqlc.GetBucketForUpdateParams{ID: id, UserID: userID})
		if err != nil {
			return notFound(err, id)
		}
		tf, err := balance.Buckets(ctx, tx, userID)
		if err != nil {
			return err
		}
		// Before the delete: the ledger refuses lines on deleted buckets.
		if !tf[id].IsZero() {
			if _, err := s.ledger.Record(ctx, tx, ledger.Entry{
				UserID: userID, CreatedBy: userID, Type: sqlc.TransactionTypeBUA, At: s.now(),
				BucketLines: []ledger.BucketLine{{BucketID: id, Amount: tf[id].Neg()}},
			}); err != nil {
				return fmt.Errorf("release target funds: %w", err)
			}
		}
		if err := q.DeleteBucket(ctx, sqlc.DeleteBucketParams{ID: id, UserID: userID}); err != nil {
			return err
		}
		// Its CAF is free for the account's other buckets.
		return allocation.Run(ctx, tx, userID, []string{row.SourceAccountID}, true)
	})
}

// compact returns the distinct IDs.
func compact(ids ...string) []string {
	slices.Sort(ids)
	return slices.Compact(ids)
}

func (s *Service) get(ctx context.Context, db sqlc.DBTX, userID, id string) (Bucket, error) {
	row, err := sqlc.New(db).GetBucket(ctx, sqlc.GetBucketParams{ID: id, UserID: userID})
	if err != nil {
		return Bucket{}, notFound(err, id)
	}
	tf, err := balance.Buckets(ctx, db, userID)
	if err != nil {
		return Bucket{}, err
	}
	return toBucket(row.Bucket, row.Currency, tf[id]), nil
}

// Capacity is a bucket's BC: RA × multiplier, rounded, or the fixed amount.
func Capacity(b sqlc.Bucket) decimal.Decimal {
	if b.CapMode == sqlc.BucketCapModeFixed {
		return b.CapAmount.Decimal
	}
	return money.Round(b.RefillAmount.Mul(b.CapMultiplier.Decimal))
}

func toBucket(r sqlc.Bucket, currency string, tf decimal.Decimal) Bucket {
	return Bucket{Bucket: r, Currency: currency, TargetFunds: tf, Capacity: Capacity(r)}
}

// settings are a bucket's refill and allocation settings, checked together.
type settings struct {
	RefillAmount        decimal.Decimal
	CapMode             sqlc.BucketCapMode
	CapMultiplier       decimal.NullDecimal
	CapAmount           decimal.NullDecimal
	KeepFunds           bool
	RefillMode          sqlc.RefillMode
	OverflowDestination sqlc.OverflowDestination
	Priority            bool
	Importance          int
	// dbImportance is Importance as stored, set by check.
	dbImportance int16
}

// apply applies c. Switching the capacity mode without giving the new mode's
// value uses its default: multiplier 1, or a fixed amount equal to RA.
func (st *settings) apply(c Changes) error {
	if c.RefillAmount != nil {
		st.RefillAmount = *c.RefillAmount
	}
	if c.CapMode != nil && *c.CapMode != st.CapMode {
		st.CapMode = *c.CapMode
		st.CapMultiplier, st.CapAmount = decimal.NullDecimal{}, decimal.NullDecimal{}
		if st.CapMode == sqlc.BucketCapModeFixed {
			st.CapAmount = decimal.NewNullDecimal(decimal.Zero)
		} else {
			st.CapMultiplier = decimal.NewNullDecimal(decimal.NewFromInt(1))
		}
	}
	if c.CapMultiplier != nil {
		if st.CapMode != sqlc.BucketCapModeMultiplier {
			return fmt.Errorf("%w: cap_multiplier is only used with the multiplier capacity mode", ErrInvalid)
		}
		st.CapMultiplier = decimal.NewNullDecimal(*c.CapMultiplier)
	}
	if c.CapAmount != nil {
		if st.CapMode != sqlc.BucketCapModeFixed {
			return fmt.Errorf("%w: cap_amount is only used with the fixed capacity mode", ErrInvalid)
		}
		st.CapAmount = decimal.NewNullDecimal(*c.CapAmount)
	}
	if c.KeepFunds != nil {
		st.KeepFunds = *c.KeepFunds
	}
	if c.RefillMode != nil {
		st.RefillMode = *c.RefillMode
	}
	if c.OverflowDestination != nil {
		st.OverflowDestination = *c.OverflowDestination
	}
	if c.Priority != nil {
		st.Priority = *c.Priority
	}
	if c.Importance != nil {
		st.Importance = *c.Importance
	}
	return nil
}

// check validates st and raises a fixed capacity below RA to RA (spec §4).
func (st *settings) check() error {
	if err := money.Valid(st.RefillAmount); err != nil {
		return fmt.Errorf("%w: refill amount: %w", ErrInvalid, err)
	}
	if st.RefillAmount.IsNegative() {
		return fmt.Errorf("%w: the refill amount is negative", ErrInvalid)
	}
	switch st.CapMode {
	case sqlc.BucketCapModeMultiplier:
		m := st.CapMultiplier.Decimal
		if !m.Equal(m.Round(2)) || m.LessThan(decimal.NewFromInt(1)) || m.GreaterThan(decimal.NewFromFloat(MaxMultiplier)) {
			return fmt.Errorf("%w: the capacity multiplier must be 1.00 to %.2f, with at most 2 decimals", ErrInvalid, MaxMultiplier)
		}
	case sqlc.BucketCapModeFixed:
		if err := money.Valid(st.CapAmount.Decimal); err != nil {
			return fmt.Errorf("%w: capacity: %w", ErrInvalid, err)
		}
		if st.CapAmount.Decimal.LessThan(st.RefillAmount) {
			st.CapAmount.Decimal = st.RefillAmount
		}
	default:
		return fmt.Errorf("%w: capacity mode %q", ErrInvalid, st.CapMode)
	}
	if !st.RefillMode.Valid() {
		return fmt.Errorf("%w: refill mode %q", ErrInvalid, st.RefillMode)
	}
	if !st.OverflowDestination.Valid() {
		return fmt.Errorf("%w: overflow destination %q", ErrInvalid, st.OverflowDestination)
	}
	if st.OverflowDestination != sqlc.OverflowDestinationUnallocated {
		return fmt.Errorf("%w: the overflow destination %s isn't available yet; use unallocated", ErrInvalid, st.OverflowDestination)
	}
	imp := st.Importance
	if imp < 1 || imp > 10 {
		return fmt.Errorf("%w: the importance must be 1 to 10", ErrInvalid)
	}
	st.dbImportance = int16(imp)
	return nil
}

// sourceCurrency checks that accountID is a live account of the user and
// returns its currency.
func sourceCurrency(ctx context.Context, q *sqlc.Queries, userID, accountID string) (string, error) {
	rows, err := q.GetOwnedAccounts(ctx, sqlc.GetOwnedAccountsParams{Ids: []string{accountID}, UserID: userID})
	if err != nil {
		return "", err
	}
	if len(rows) == 0 {
		return "", fmt.Errorf("%w: account %s doesn't exist", ErrInvalid, accountID)
	}
	return rows[0].Currency, nil
}

// checkNewSource checks that a bucket can move from account from to account
// to: TF is an amount in the old account's currency.
func checkNewSource(ctx context.Context, q *sqlc.Queries, userID, from, to string) error {
	want, err := sourceCurrency(ctx, q, userID, from)
	if err != nil {
		return err
	}
	got, err := sourceCurrency(ctx, q, userID, to)
	if err != nil {
		return err
	}
	if got != want {
		return fmt.Errorf("%w: %s is %s, %s is %s", ErrCurrencyMismatch, from, want, to, got)
	}
	return nil
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
		return fmt.Errorf("%w: bucket %s", ErrNotFound, id)
	}
	return err
}

// nameTaken turns a clash on the unique name index into ErrNameTaken.
func nameTaken(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "buckets_user_name_key" {
		return ErrNameTaken
	}
	return err
}
