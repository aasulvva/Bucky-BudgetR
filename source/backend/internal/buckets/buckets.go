// Package buckets manages buckets (spec §4): creating one with its opening
// funds, changing its settings and deleting it.
//
// A Fully manual bucket (#76) is never refilled: it has no refill amount,
// always keeps its funds, and its capacity is a fixed amount or none. Its
// funds only change through adjustments (Add and Remove funds are temporary
// adjustments) and transfers.
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
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/allocation"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/balance"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cards"
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
	// ErrNoChange means an adjustment wouldn't change anything.
	ErrNoChange = errors.New("nothing would change")
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
// ledger) and its calculated Bucket Capacity (BC), unset with no capacity.
type Bucket struct {
	sqlc.Bucket
	Currency    string
	TargetFunds decimal.Decimal
	Capacity    decimal.NullDecimal
	// Refilled is set when the bucket has been refilled in the active cycle.
	Refilled bool
}

// New describes a bucket to create. Zero values get the defaults.
type New struct {
	Name            string
	SourceAccountID string
	RefillAmount    decimal.Decimal
	// CapMode defaults to multiplier, or none for a Fully manual bucket.
	CapMode sqlc.BucketCapMode
	// CapMultiplier is for the multiplier mode and defaults to 1.
	CapMultiplier decimal.Decimal
	// CapAmount is for the fixed mode. It is raised to RefillAmount if lower.
	CapAmount decimal.Decimal
	// KeepFunds is always on for a Fully manual bucket.
	KeepFunds bool
	// NegativeTF defaults to the user's default_negative_tf preference, or
	// debt.
	NegativeTF sqlc.NegativeTf
	// RefillMode defaults to the user's default_refill_mode preference, or
	// auto.
	RefillMode sqlc.RefillMode
	// OverflowDestination defaults to unallocated. A Fully manual bucket
	// never overflows, so it's always unallocated.
	OverflowDestination sqlc.OverflowDestination
	// OverflowTargetID is the savings target overflow goes to, with the
	// savings_target destination (#233): a live target in the bucket's
	// currency.
	OverflowTargetID string
	Priority         bool
	// Importance is 1–10 and defaults to DefaultImportance.
	Importance int
	// OpeningFunds is recorded as an Opening Funds (OPF) transaction now.
	// Zero records nothing; otherwise the user needs an active cycle, and
	// the opening funds count as the bucket's refill in it.
	OpeningFunds decimal.Decimal
	// Refill refills the bucket now in the active cycle, whatever its
	// refill mode except Fully manual. It can't be combined with
	// OpeningFunds.
	Refill bool
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
	NegativeTF          *sqlc.NegativeTf
	RefillMode          *sqlc.RefillMode
	OverflowDestination *sqlc.OverflowDestination
	// OverflowTargetID is the target for the savings_target destination;
	// another destination clears it.
	OverflowTargetID *string
	Priority         *bool
	Importance       *int
}

// CreateHook runs in Create's transaction for a bucket created with opening
// funds or a refill. It marks the bucket refilled in the active cycle, and
// refills it first if refill is set.
type CreateHook func(ctx context.Context, tx pgx.Tx, userID, bucketID string, refill bool) error

// Options configures a Service.
type Options struct {
	// Now returns the current time. Defaults to time.Now.
	Now func() time.Time
	// OnCreate is refill.Service.OnCreate (refill imports this package).
	// Nil means New.Refill is refused and opening funds don't count as a
	// refill.
	OnCreate CreateHook
	// ReleaseSavings is savings.Service.ReleaseBucket (#231): it releases the
	// money held for the bucket's savings target and deletes the target, when
	// the bucket is deleted or stops being Fully manual. Nil skips it.
	ReleaseSavings ReleaseHook
}

// ReleaseHook runs in the transaction that deletes a bucket, or switches it
// away from Fully manual.
type ReleaseHook func(ctx context.Context, tx pgx.Tx, userID, bucketID string) error

// Service manages buckets.
type Service struct {
	pool           *pgxpool.Pool
	ledger         *ledger.Ledger
	now            func() time.Time
	onCreate       CreateHook
	releaseSavings ReleaseHook
}

// NewService returns a Service that records money movements in l.
func NewService(pool *pgxpool.Pool, l *ledger.Ledger, opts Options) *Service {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Service{pool: pool, ledger: l, now: opts.Now, onCreate: opts.OnCreate, releaseSavings: opts.ReleaseSavings}
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
		out[i] = toBucket(r.Bucket, r.Currency, tf[r.Bucket.ID], r.Refilled)
	}
	return out, nil
}

// Figures is a bucket's figures for a cycle.
type Figures struct {
	BucketID string
	balance.Figures
}

// CycleFigures returns the figures of each of the user's buckets that isn't
// deleted for a cycle, sorted by bucket ID. It returns balance.ErrNotFound
// if the cycle isn't the user's.
func (s *Service) CycleFigures(ctx context.Context, userID, cycleID string) ([]Figures, error) {
	figs, err := balance.Cycle(ctx, s.pool, userID, cycleID)
	if err != nil {
		return nil, err
	}
	rows, err := sqlc.New(s.pool).ListBuckets(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make([]Figures, len(rows))
	for i, r := range rows {
		out[i] = Figures{BucketID: r.Bucket.ID, Figures: figs[r.Bucket.ID]}
	}
	slices.SortFunc(out, func(a, b Figures) int { return strings.Compare(a.BucketID, b.BucketID) })
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
	if n.Refill && !n.OpeningFunds.IsZero() {
		return Bucket{}, fmt.Errorf("%w: a new bucket gets either opening funds or a refill", ErrInvalid)
	}
	if n.Refill && s.onCreate == nil {
		return Bucket{}, fmt.Errorf("%w: refilling a new bucket isn't available", ErrInvalid)
	}

	var out Bucket
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		// The source must be a live account of the user.
		currency, err := sourceCurrency(ctx, q, userID, n.SourceAccountID)
		if err != nil {
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
		manual := n.RefillMode == sqlc.RefillModeFullyManual
		if n.CapMode == "" {
			n.CapMode = sqlc.BucketCapModeMultiplier
			if manual {
				n.CapMode = sqlc.BucketCapModeNone
			}
		}
		if manual {
			if n.Refill {
				return errNeverRefilled
			}
			n.KeepFunds = true
		}
		if n.NegativeTF == "" {
			pref, err := q.GetDefaultNegativeTF(ctx, userID)
			if err != nil {
				return err
			}
			n.NegativeTF = sqlc.NegativeTf(pref)
			if !n.NegativeTF.Valid() {
				n.NegativeTF = sqlc.NegativeTfDebt
			}
		}
		st := settings{
			RefillAmount: n.RefillAmount, CapMode: n.CapMode, KeepFunds: n.KeepFunds, NegativeTF: n.NegativeTF,
			RefillMode: n.RefillMode, OverflowDestination: n.OverflowDestination, OverflowTargetID: n.OverflowTargetID,
			Priority: n.Priority, Importance: n.Importance,
		}
		switch n.CapMode {
		case sqlc.BucketCapModeFixed:
			st.CapAmount = decimal.NewNullDecimal(n.CapAmount)
		case sqlc.BucketCapModeMultiplier:
			st.CapMultiplier = decimal.NewNullDecimal(n.CapMultiplier)
		}
		if err := st.check(); err != nil {
			return err
		}
		if err := checkOverflowTarget(ctx, q, userID, "", currency, st.OverflowTargetID); err != nil {
			return err
		}
		if manual {
			if err := checkCapacity(st.capacity(), n.OpeningFunds); err != nil {
				return err
			}
		}

		var row sqlc.Bucket
		_, err = ids.Insert(ctx, ids.Bucket, func() string { return ids.NewBucket(userID) }, func(ctx context.Context, id string) (bool, error) {
			var err error
			row, err = q.CreateBucket(ctx, sqlc.CreateBucketParams{
				ID: id, UserID: userID, Name: name, SourceAccountID: n.SourceAccountID,
				RefillAmount: st.RefillAmount, CapMode: st.CapMode, CapMultiplier: st.CapMultiplier, CapAmount: st.CapAmount,
				KeepFunds: st.KeepFunds, RefillMode: st.RefillMode, OverflowDestination: st.OverflowDestination,
				Priority: st.Priority, Importance: st.dbImportance, NegativeTf: st.NegativeTF,
				OverflowTargetID: pgtype.Text{String: st.OverflowTargetID, Valid: st.OverflowTargetID != ""},
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
		// A Fully manual bucket is never refilled, so it isn't marked.
		if s.onCreate != nil && !manual && (n.Refill || !n.OpeningFunds.IsZero()) {
			if err := s.onCreate(ctx, tx, userID, row.ID, n.Refill); err != nil {
				return err
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
		before, err := update(ctx, tx, userID, id, c)
		if err != nil {
			return err
		}
		// Only a Fully manual bucket can be a savings target.
		if s.releaseSavings != nil && before.RefillMode == sqlc.RefillModeFullyManual &&
			c.RefillMode != nil && *c.RefillMode != sqlc.RefillModeFullyManual {
			if err := s.releaseSavings(ctx, tx, userID, id); err != nil {
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

// RefillAmount is one bucket's new refill amount, for SetRefillAmounts.
type RefillAmount struct {
	BucketID string
	Amount   decimal.Decimal
}

// SetRefillAmounts sets several buckets' refill amounts, all or nothing
// (Budget setup, spec §9). Like Update, a fixed capacity below the new
// amount is raised to it. TF is unchanged, unless thisCycle (#81): then each
// bucket refilled in the active cycle also gets a BUA of the change in RA,
// as Adjust's ModeBoth; one not refilled yet gets the new RA at its refill.
// The frontend previews this with cycleChanges (lib/budget.ts); change both
// together. It returns the buckets in the order given.
func (s *Service) SetRefillAmounts(ctx context.Context, userID string, items []RefillAmount, thisCycle bool) ([]Bucket, error) {
	seen := make(map[string]bool, len(items))
	for _, it := range items {
		if seen[it.BucketID] {
			return nil, fmt.Errorf("%w: bucket %s is listed twice", ErrInvalid, it.BucketID)
		}
		seen[it.BucketID] = true
	}
	out := make([]Bucket, len(items))
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		if thisCycle {
			// Also when no bucket was refilled, so the choice can't pass unnoticed.
			if _, err := sqlc.New(tx).GetActiveCycle(ctx, userID); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return ledger.ErrNoActiveCycle
				}
				return err
			}
		}
		changes := make(map[string]decimal.Decimal, len(items))
		for _, it := range items {
			before, err := s.get(ctx, tx, userID, it.BucketID)
			if err != nil {
				return err
			}
			if before.RefillMode == sqlc.RefillModeFullyManual {
				return fmt.Errorf("%w: bucket %s: %w", ErrInvalid, it.BucketID, errNoRefillAmount)
			}
			if thisCycle && before.Refilled {
				changes[it.BucketID] = it.Amount.Sub(before.RefillAmount)
			}
			if _, err := update(ctx, tx, userID, it.BucketID, Changes{RefillAmount: &it.Amount}); err != nil {
				return err
			}
		}
		for _, it := range items {
			if change := changes[it.BucketID]; !change.IsZero() {
				if err := s.recordBUA(ctx, tx, userID, it.BucketID, change); err != nil {
					return err
				}
			}
		}
		for i, it := range items {
			var err error
			if out[i], err = s.get(ctx, tx, userID, it.BucketID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// update applies c to the bucket in tx, which holds the user's lock.
// update changes the bucket and returns it as it was.
func update(ctx context.Context, tx pgx.Tx, userID, id string, c Changes) (row sqlc.Bucket, err error) {
	q := sqlc.New(tx)
	row, err = q.GetBucketForUpdate(ctx, sqlc.GetBucketForUpdateParams{ID: id, UserID: userID})
	if err != nil {
		return row, notFound(err, id)
	}
	p := sqlc.UpdateBucketParams{ID: id, UserID: userID, Name: row.Name, SourceAccountID: row.SourceAccountID, Caf: row.Caf}
	if c.Name != nil {
		if p.Name, err = checkName(*c.Name); err != nil {
			return row, err
		}
	}
	if c.SourceAccountID != nil && *c.SourceAccountID != row.SourceAccountID {
		if err := checkNewSource(ctx, q, userID, row.SourceAccountID, *c.SourceAccountID); err != nil {
			return row, err
		}
		p.SourceAccountID = *c.SourceAccountID
		p.Caf = decimal.Zero
	}

	st := settings{
		RefillAmount: row.RefillAmount, CapMode: row.CapMode, CapMultiplier: row.CapMultiplier, CapAmount: row.CapAmount,
		KeepFunds: row.KeepFunds, NegativeTF: row.NegativeTf, RefillMode: row.RefillMode, OverflowDestination: row.OverflowDestination,
		OverflowTargetID: row.OverflowTargetID.String, Priority: row.Priority, Importance: int(row.Importance),
	}
	if err := st.apply(c); err != nil {
		return row, err
	}
	if err := st.check(); err != nil {
		return row, err
	}
	if st.OverflowTargetID != row.OverflowTargetID.String {
		currency, err := sourceCurrency(ctx, q, userID, p.SourceAccountID)
		if err != nil {
			return row, err
		}
		if err := checkOverflowTarget(ctx, q, userID, id, currency, st.OverflowTargetID); err != nil {
			return row, err
		}
	}
	p.RefillAmount, p.CapMode, p.CapMultiplier, p.CapAmount = st.RefillAmount, st.CapMode, st.CapMultiplier, st.CapAmount
	p.KeepFunds, p.NegativeTf, p.RefillMode, p.OverflowDestination = st.KeepFunds, st.NegativeTF, st.RefillMode, st.OverflowDestination
	p.Priority, p.Importance = st.Priority, st.dbImportance
	p.OverflowTargetID = pgtype.Text{String: st.OverflowTargetID, Valid: st.OverflowTargetID != ""}
	if err := q.UpdateBucket(ctx, p); err != nil {
		return row, nameTaken(err)
	}
	// Settings that change how the money is split take effect at once.
	if p.SourceAccountID != row.SourceAccountID || p.Priority != row.Priority || p.Importance != row.Importance {
		if err := allocation.Run(ctx, tx, userID, compact(row.SourceAccountID, p.SourceAccountID), true); err != nil {
			return row, err
		}
	}
	return row, nil
}

// Mode is how an adjustment applies (spec §9): to this cycle's TF, to RA
// from the next refill, or both.
type Mode string

const (
	// ModeTemporary changes TF for this cycle with a BUA or BAT; RA stays.
	ModeTemporary Mode = "temporary"
	// ModeFuture changes RA, from the next refill; TF stays and nothing is
	// recorded.
	ModeFuture Mode = "future"
	// ModeBoth changes RA, and TF by the same amount.
	ModeBoth Mode = "both"
)

// Adjustment changes one bucket's funds. ModeTemporary takes TargetFunds,
// the other modes RefillAmount.
type Adjustment struct {
	Mode         Mode
	TargetFunds  *decimal.Decimal
	RefillAmount *decimal.Decimal
}

// Adjust applies a to the bucket. ModeTemporary sets TF (0 or more) with a
// Budget Adjustment (BUA) for the difference. ModeFuture sets RA as Update
// does. ModeBoth sets RA and records a BUA of the same change, so TF moves
// by that amount and may go below 0. A BUA needs an active cycle.
func (s *Service) Adjust(ctx context.Context, userID, id string, a Adjustment) (Bucket, error) {
	var out Bucket
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		row, err := sqlc.New(tx).GetBucketForUpdate(ctx, sqlc.GetBucketForUpdateParams{ID: id, UserID: userID})
		if err != nil {
			return notFound(err, id)
		}
		var change decimal.Decimal
		manual := row.RefillMode == sqlc.RefillModeFullyManual
		if manual && a.Mode != ModeTemporary {
			return fmt.Errorf("%w: %w", ErrInvalid, errNoRefillAmount)
		}
		switch a.Mode {
		case ModeTemporary:
			if a.TargetFunds == nil || a.RefillAmount != nil {
				return fmt.Errorf("%w: a temporary adjustment takes target_funds only", ErrInvalid)
			}
			if err := money.Valid(*a.TargetFunds); err != nil {
				return fmt.Errorf("%w: target funds: %w", ErrInvalid, err)
			}
			if a.TargetFunds.IsNegative() {
				return fmt.Errorf("%w: the target funds can't be negative", ErrInvalid)
			}
			if manual {
				if err := checkCapacity(Capacity(row), *a.TargetFunds); err != nil {
					return err
				}
			}
			tf, err := balance.Buckets(ctx, tx, userID)
			if err != nil {
				return err
			}
			change = a.TargetFunds.Sub(tf[id])
			if change.IsZero() {
				return fmt.Errorf("%w: the target funds are already %s", ErrNoChange, tf[id].StringFixed(money.Places))
			}
		case ModeFuture, ModeBoth:
			if a.RefillAmount == nil || a.TargetFunds != nil {
				return fmt.Errorf("%w: a %s adjustment takes refill_amount only", ErrInvalid, a.Mode)
			}
			if a.RefillAmount.Equal(row.RefillAmount) {
				return fmt.Errorf("%w: the refill amount is already %s", ErrNoChange, row.RefillAmount.StringFixed(money.Places))
			}
			if _, err := update(ctx, tx, userID, id, Changes{RefillAmount: a.RefillAmount}); err != nil {
				return err
			}
			if a.Mode == ModeBoth {
				change = a.RefillAmount.Sub(row.RefillAmount)
			}
		default:
			return fmt.Errorf("%w: adjustment mode %q", ErrInvalid, a.Mode)
		}
		if !change.IsZero() {
			if err := s.recordBUA(ctx, tx, userID, id, change); err != nil {
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

// recordBUA records a bucket adjustment of change on the bucket, now.
func (s *Service) recordBUA(ctx context.Context, tx pgx.Tx, userID, id string, change decimal.Decimal) error {
	_, err := s.ledger.Record(ctx, tx, ledger.Entry{
		UserID: userID, CreatedBy: userID, Type: sqlc.TransactionTypeBUA, At: s.now(),
		BucketLines: []ledger.BucketLine{{BucketID: id, Amount: change}},
	})
	return err
}

// Transfer moves funds from one bucket to another.
type Transfer struct {
	To     string
	Mode   Mode
	Amount decimal.Decimal
}

// Transfer moves t.Amount from the bucket to t.To, in the same currency.
// ModeTemporary moves TF with a Budget Adjustment Transfer (BAT); the sender
// may go below 0. ModeFuture moves RA (the sender needs at least the
// amount), and ModeBoth both. Between buckets on one account, the allocation
// routine moves CAF along with TF. It returns both buckets.
func (s *Service) Transfer(ctx context.Context, userID, from string, t Transfer) (Bucket, Bucket, error) {
	if from == t.To {
		return Bucket{}, Bucket{}, fmt.Errorf("%w: a bucket can't move funds to itself", ErrInvalid)
	}
	if err := money.Valid(t.Amount); err != nil {
		return Bucket{}, Bucket{}, fmt.Errorf("%w: amount: %w", ErrInvalid, err)
	}
	if !t.Amount.IsPositive() {
		return Bucket{}, Bucket{}, fmt.Errorf("%w: the amount must be above 0", ErrInvalid)
	}
	var out [2]Bucket
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		src, err := q.GetBucketForUpdate(ctx, sqlc.GetBucketForUpdateParams{ID: from, UserID: userID})
		if err != nil {
			return notFound(err, from)
		}
		dst, err := q.GetBucketForUpdate(ctx, sqlc.GetBucketForUpdateParams{ID: t.To, UserID: userID})
		if err != nil {
			return notFound(err, t.To)
		}
		if err := checkNewSource(ctx, q, userID, src.SourceAccountID, dst.SourceAccountID); err != nil {
			return err
		}
		srcManual, dstManual := src.RefillMode == sqlc.RefillModeFullyManual, dst.RefillMode == sqlc.RefillModeFullyManual
		switch t.Mode {
		case ModeTemporary:
			if dstManual {
				tf, err := balance.Buckets(ctx, tx, userID)
				if err != nil {
					return err
				}
				if err := checkCapacity(Capacity(dst), tf[t.To].Add(t.Amount)); err != nil {
					return err
				}
			}
		case ModeFuture, ModeBoth:
			if srcManual || dstManual {
				return fmt.Errorf("%w: %w", ErrInvalid, errNoRefillAmount)
			}
			if src.RefillAmount.LessThan(t.Amount) {
				return fmt.Errorf("%w: the refill amount is only %s", ErrInvalid, src.RefillAmount.StringFixed(money.Places))
			}
			for _, c := range []struct {
				id string
				ra decimal.Decimal
			}{{from, src.RefillAmount.Sub(t.Amount)}, {t.To, dst.RefillAmount.Add(t.Amount)}} {
				if _, err := update(ctx, tx, userID, c.id, Changes{RefillAmount: &c.ra}); err != nil {
					return err
				}
			}
		default:
			return fmt.Errorf("%w: adjustment mode %q", ErrInvalid, t.Mode)
		}
		if t.Mode != ModeFuture {
			if _, err := s.ledger.Record(ctx, tx, ledger.Entry{
				UserID: userID, CreatedBy: userID, Type: sqlc.TransactionTypeBAT, At: s.now(),
				BucketLines: []ledger.BucketLine{{BucketID: from, Amount: t.Amount.Neg()}, {BucketID: t.To, Amount: t.Amount}},
			}); err != nil {
				return err
			}
		}
		for i, id := range []string{from, t.To} {
			if out[i], err = s.get(ctx, tx, userID, id); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return Bucket{}, Bucket{}, err
	}
	return out[0], out[1], nil
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
		// Savings held for it go back to unallocated, and its target goes.
		if s.releaseSavings != nil {
			if err := s.releaseSavings(ctx, tx, userID, id); err != nil {
				return err
			}
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
	return toBucket(row.Bucket, row.Currency, tf[id], row.Refilled), nil
}

// Capacity is a bucket's BC: RA × multiplier, rounded, or the fixed amount.
// It is unset with no capacity.
func Capacity(b sqlc.Bucket) decimal.NullDecimal {
	switch b.CapMode {
	case sqlc.BucketCapModeFixed:
		return b.CapAmount
	case sqlc.BucketCapModeNone:
		return decimal.NullDecimal{}
	}
	return decimal.NewNullDecimal(money.Round(b.RefillAmount.Mul(b.CapMultiplier.Decimal)))
}

var (
	errNoRefillAmount = errors.New("a fully manual bucket has no refill amount")
	errNeverRefilled  = fmt.Errorf("%w: a fully manual bucket is never refilled", ErrInvalid)
)

// checkCapacity refuses funds above a Fully manual bucket's capacity, if it
// has one (#76).
func checkCapacity(capacity decimal.NullDecimal, funds decimal.Decimal) error {
	if capacity.Valid && funds.GreaterThan(capacity.Decimal) {
		return fmt.Errorf("%w: the bucket's capacity is %s", ErrInvalid, capacity.Decimal.StringFixed(money.Places))
	}
	return nil
}

func toBucket(r sqlc.Bucket, currency string, tf decimal.Decimal, refilled bool) Bucket {
	return Bucket{Bucket: r, Currency: currency, TargetFunds: tf, Capacity: Capacity(r), Refilled: refilled}
}

// settings are a bucket's refill and allocation settings, checked together.
type settings struct {
	RefillAmount        decimal.Decimal
	CapMode             sqlc.BucketCapMode
	CapMultiplier       decimal.NullDecimal
	CapAmount           decimal.NullDecimal
	KeepFunds           bool
	NegativeTF          sqlc.NegativeTf
	RefillMode          sqlc.RefillMode
	OverflowDestination sqlc.OverflowDestination
	OverflowTargetID    string
	Priority            bool
	Importance          int
	// dbImportance is Importance as stored, set by check.
	dbImportance int16
}

// capacity is the capacity st gives, as Capacity.
func (st *settings) capacity() decimal.NullDecimal {
	return Capacity(sqlc.Bucket{RefillAmount: st.RefillAmount, CapMode: st.CapMode, CapMultiplier: st.CapMultiplier, CapAmount: st.CapAmount})
}

// apply applies c. Switching the capacity mode without giving the new mode's
// value uses its default: multiplier 1, or a fixed amount equal to RA.
//
// Switching to Fully manual sets what c doesn't give: RA 0, Keep funds on,
// and no capacity instead of a multiplier. Switching away from it with no
// capacity and none given uses multiplier 1.
func (st *settings) apply(c Changes) error {
	was := st.RefillMode
	if c.RefillAmount != nil {
		st.RefillAmount = *c.RefillAmount
	}
	if c.CapMode != nil && *c.CapMode != st.CapMode {
		st.CapMode = *c.CapMode
		st.CapMultiplier, st.CapAmount = decimal.NullDecimal{}, decimal.NullDecimal{}
		switch st.CapMode {
		case sqlc.BucketCapModeFixed:
			st.CapAmount = decimal.NewNullDecimal(decimal.Zero)
		case sqlc.BucketCapModeMultiplier:
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
	if c.NegativeTF != nil {
		st.NegativeTF = *c.NegativeTF
	}
	if c.RefillMode != nil {
		st.RefillMode = *c.RefillMode
	}
	if c.OverflowDestination != nil {
		st.OverflowDestination = *c.OverflowDestination
	}
	if c.OverflowTargetID != nil {
		st.OverflowTargetID = *c.OverflowTargetID
	}
	// Another destination drops the target.
	if st.OverflowDestination != sqlc.OverflowDestinationSavingsTarget && c.OverflowTargetID == nil {
		st.OverflowTargetID = ""
	}
	if c.Priority != nil {
		st.Priority = *c.Priority
	}
	if c.Importance != nil {
		st.Importance = *c.Importance
	}
	manual := st.RefillMode == sqlc.RefillModeFullyManual
	switch {
	case manual && was != sqlc.RefillModeFullyManual:
		if c.RefillAmount == nil {
			st.RefillAmount = decimal.Zero
		}
		if c.KeepFunds == nil {
			st.KeepFunds = true
		}
		if c.CapMode == nil && st.CapMode == sqlc.BucketCapModeMultiplier {
			st.CapMode, st.CapMultiplier = sqlc.BucketCapModeNone, decimal.NullDecimal{}
		}
		// It never overflows (#233).
		if c.OverflowDestination == nil {
			st.OverflowDestination, st.OverflowTargetID = sqlc.OverflowDestinationUnallocated, ""
		}
	case !manual && c.CapMode == nil && st.CapMode == sqlc.BucketCapModeNone:
		st.CapMode, st.CapMultiplier = sqlc.BucketCapModeMultiplier, decimal.NewNullDecimal(decimal.NewFromInt(1))
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
	case sqlc.BucketCapModeNone:
		if st.RefillMode != sqlc.RefillModeFullyManual {
			return fmt.Errorf("%w: only a fully manual bucket can have no capacity", ErrInvalid)
		}
	default:
		return fmt.Errorf("%w: capacity mode %q", ErrInvalid, st.CapMode)
	}
	if !st.RefillMode.Valid() {
		return fmt.Errorf("%w: refill mode %q", ErrInvalid, st.RefillMode)
	}
	if st.RefillMode == sqlc.RefillModeFullyManual {
		switch {
		case !st.RefillAmount.IsZero():
			return fmt.Errorf("%w: %w", ErrInvalid, errNoRefillAmount)
		case !st.KeepFunds:
			return fmt.Errorf("%w: a fully manual bucket always keeps its funds", ErrInvalid)
		case st.CapMode == sqlc.BucketCapModeMultiplier:
			return fmt.Errorf("%w: a fully manual bucket's capacity is a fixed amount or none", ErrInvalid)
		}
	}
	if !st.NegativeTF.Valid() {
		return fmt.Errorf("%w: negative TF handling %q", ErrInvalid, st.NegativeTF)
	}
	if !st.OverflowDestination.Valid() {
		return fmt.Errorf("%w: overflow destination %q", ErrInvalid, st.OverflowDestination)
	}
	if st.RefillMode == sqlc.RefillModeFullyManual && st.OverflowDestination != sqlc.OverflowDestinationUnallocated {
		return fmt.Errorf("%w: a fully manual bucket never overflows, so its overflow destination is unallocated", ErrInvalid)
	}
	if (st.OverflowDestination == sqlc.OverflowDestinationSavingsTarget) != (st.OverflowTargetID != "") {
		return fmt.Errorf("%w: overflow_target_id is needed with, and only used with, the savings_target destination", ErrInvalid)
	}
	imp := st.Importance
	if imp < 1 || imp > 10 {
		return fmt.Errorf("%w: the importance must be 1 to 10", ErrInvalid)
	}
	st.dbImportance = int16(imp)
	return nil
}

// checkOverflowTarget checks that targetID, if set, is a live savings target
// of the user in currency, and not the bucket bucketID itself (#233).
func checkOverflowTarget(ctx context.Context, q *sqlc.Queries, userID, bucketID, currency, targetID string) error {
	if targetID == "" {
		return nil
	}
	t, err := q.SavingsTargetForOverflow(ctx, sqlc.SavingsTargetForOverflowParams{ID: targetID, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: %s isn't one of your savings targets", ErrInvalid, targetID)
	}
	if err != nil {
		return err
	}
	if bucketID != "" && t.BucketID.String == bucketID {
		return fmt.Errorf("%w: a bucket can't send its overflow to itself", ErrInvalid)
	}
	if t.Currency != currency {
		return fmt.Errorf("%w: the savings target is in %s, the bucket in %s", ErrInvalid, t.Currency, currency)
	}
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
	// A credit card has no money of its own to fund a bucket (#260).
	cardIDs, err := q.ListCardIDs(ctx, userID)
	if err != nil {
		return "", err
	}
	if slices.Contains(cardIDs, accountID) {
		return "", fmt.Errorf("%w: account %s", cards.ErrSource, accountID)
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
