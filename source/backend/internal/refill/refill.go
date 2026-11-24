// Package refill holds the cycle routines (spec §6): refilling buckets with a
// REF, and removing what doesn't roll over with an OVF.
//
// A bucket is refilled at most once per cycle, according to its refill mode:
//
//   - Auto: at cycle start (OnStart, a cycles hook).
//   - Manual: when the user asks (Manual).
//   - On income: when an income triggers it (OnIncome, called by the
//     transactions service). Reversing the income undoes it (UndoIncome).
//   - Fully manual (#76): never. Its funds only change through adjustments,
//     and it always keeps them.
//
// A bucket created in the active cycle with a refill or opening funds counts
// as refilled in it, whatever its mode (OnCreate, a buckets hook).
//
// At cycle end (OnEnd), buckets without Keep funds are emptied.
//
// Overflow goes where the bucket says (#233, spec §8.5): the part its CAF
// covered can be held for the savings distributor or a savings target, with
// savings lines on the OVF (Options.Savings).
//
// The savings budget's fixed amounts (#234, spec §8.6) run after the refills
// of the same moment, at cycle start and on income, and are undone with the
// income (Options.Savings). Its sweeps (#235) run after each refill once the
// account is refilled, undone with a refill on it, and at cycle end.
//
// Every routine runs inside the caller's database transaction, under the
// user's lock (ledger.LockUser), and records through the ledger, so the
// allocation routine follows each REF and OVF.
package refill

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/allocation"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/balance"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cards"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
)

var (
	// ErrNotFound means the bucket doesn't exist, is deleted or belongs to
	// another user.
	ErrNotFound = errors.New("not found")
	// ErrAlreadyRefilled means the bucket has been refilled in this cycle.
	ErrAlreadyRefilled = errors.New("the bucket has already been refilled in this cycle")
	// ErrWrongMode means the bucket's refill mode doesn't allow a manual
	// refill.
	ErrWrongMode = errors.New("only buckets with the manual refill mode can be refilled by hand")
	// ErrUnavailable means an income was marked to trigger a refill, but it
	// isn't in the active cycle.
	ErrUnavailable = errors.New("only income in the active cycle can trigger a refill")
)

// Rule is an income rule from the user's preferences (income_refill_rules):
// an income from Counterparty (ignoring case) of at least MinAmount triggers
// a refill.
type Rule struct {
	Counterparty string          `json:"counterparty"`
	MinAmount    decimal.Decimal `json:"min_amount"`
}

// Savings sends overflow to savings (#233) and runs the savings budget
// (#234). The savings service implements it; it's an interface so the
// packages don't import each other.
type Savings interface {
	// OverflowLines are the savings lines for the funded part of b's
	// overflow, none for unallocated.
	OverflowLines(ctx context.Context, tx pgx.Tx, userID string, b sqlc.Bucket, funded decimal.Decimal) ([]ledger.SavingsLine, error)
	// AfterOverflow moves them on once the OVF sourceID is recorded at at.
	AfterOverflow(ctx context.Context, tx pgx.Tx, userID, accountID, sourceID string, at time.Time, lines []ledger.SavingsLine) error
	// ReleaseOverflow takes back what the OVF t moved on, and returns what
	// reversing it then takes off hold.
	ReleaseOverflow(ctx context.Context, tx pgx.Tx, userID string, t *ledger.Transaction) ([]ledger.SavingsLine, error)
	// RunBudget runs the savings budget entries with this mode in cycle c,
	// dated at: for On income those from accountID, triggered by incomeID.
	RunBudget(ctx context.Context, tx pgx.Tx, userID string, c sqlc.Cycle, when sqlc.SavingsBudgetWhen, accountID string, at time.Time, incomeID string) error
	// UndoBudget undoes the runs the income triggered in the cycle.
	UndoBudget(ctx context.Context, tx pgx.Tx, userID, incomeID, cycleID string) error
	// UndoSweeps undoes the After the refills sweeps on the accounts in the
	// cycle (#235), when a refill on them is undone.
	UndoSweeps(ctx context.Context, tx pgx.Tx, userID, cycleID string, accountIDs []string) error
}

// Options configures a Service.
type Options struct {
	// Now returns the current time. Defaults to time.Now.
	Now func() time.Time
	// Savings sends overflow to savings and runs the savings budget; without
	// it, overflow is always unallocated and nothing is saved.
	Savings Savings
}

// Service runs the cycle routines.
type Service struct {
	pool    *pgxpool.Pool
	ledger  *ledger.Ledger
	now     func() time.Time
	savings Savings
}

// NewService returns a Service.
func NewService(pool *pgxpool.Pool, l *ledger.Ledger, opts Options) *Service {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Service{pool: pool, ledger: l, now: opts.Now, savings: opts.Savings}
}

// OnStart refills the Auto buckets, dated at the cycle's start, then runs
// the At cycle start savings budget entries, and the After the refills
// sweeps of the accounts that are refilled now (#235). Last, the buckets take
// the purchases that waited for the cycle (#264). It is the cycles OnStart
// hook.
func (s *Service) OnStart(ctx context.Context, tx pgx.Tx, c sqlc.Cycle) error {
	if err := s.refillAll(ctx, tx, c, sqlc.RefillModeAuto, "", c.StartAt, ""); err != nil {
		return err
	}
	if s.savings != nil {
		if err := s.savings.RunBudget(ctx, tx, c.UserID, c, sqlc.SavingsBudgetWhenCycleStart, "", c.StartAt, ""); err != nil {
			return err
		}
		if err := s.sweep(ctx, tx, c.UserID, c, "", c.StartAt); err != nil {
			return err
		}
	}
	// Then the buckets take the purchases that waited for this cycle (#264).
	loc, err := cards.Location(ctx, sqlc.New(tx), c.UserID)
	if err != nil {
		return err
	}
	return s.ledger.TakeDue(ctx, tx, c, loc)
}

// sweep runs the After the refills sweeps (of accountID, or all for "")
// whose accounts are refilled now, after a refill (#235).
func (s *Service) sweep(ctx context.Context, tx pgx.Tx, userID string, c sqlc.Cycle, accountID string, at time.Time) error {
	if s.savings == nil {
		return nil
	}
	return s.savings.RunBudget(ctx, tx, userID, c, sqlc.SavingsBudgetWhenAfterRefills, accountID, at, "")
}

// OnEnd empties the buckets without Keep funds: an OVF brings a positive TF
// to 0. It first checks that CAF fits the accounts, so the funded part is
// known, without reallocating otherwise. Then the At cycle end sweeps take
// what's unallocated (#235). It is the cycles OnEnd hook and runs while the
// cycle is still active.
func (s *Service) OnEnd(ctx context.Context, tx pgx.Tx, c sqlc.Cycle) error {
	if err := ledger.LockUser(ctx, tx, c.UserID); err != nil {
		return err
	}
	accounts, err := balance.Accounts(ctx, tx, c.UserID)
	if err != nil {
		return err
	}
	if err := allocation.Run(ctx, tx, c.UserID, slices.Sorted(maps.Keys(accounts)), false); err != nil {
		return err
	}

	q := sqlc.New(tx)
	list, err := q.ListOverflowBuckets(ctx, c.UserID)
	if err != nil {
		return err
	}
	tf, err := balance.Buckets(ctx, tx, c.UserID)
	if err != nil {
		return err
	}
	// Inside the cycle: a cycle ended late keeps its planned end.
	at := s.now()
	if last := c.EndAt.Add(-time.Microsecond); at.After(last) {
		at = last
	}
	for _, b := range list {
		if !tf[b.ID].IsPositive() {
			continue
		}
		if _, err := s.overflow(ctx, tx, b, tf[b.ID], decimal.Zero, at); err != nil {
			return fmt.Errorf("overflow of bucket %s: %w", b.ID, err)
		}
	}
	if s.savings == nil {
		return nil
	}
	return s.savings.RunBudget(ctx, tx, c.UserID, c, sqlc.SavingsBudgetWhenCycleEnd, "", at, "")
}

// Manual refills a bucket with the Manual refill mode, dated now.
func (s *Service) Manual(ctx context.Context, userID, bucketID string) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		b, err := q.GetBucketForUpdate(ctx, sqlc.GetBucketForUpdateParams{ID: bucketID, UserID: userID})
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("%w: bucket %s", ErrNotFound, bucketID)
		}
		if err != nil {
			return err
		}
		if b.RefillMode != sqlc.RefillModeManual {
			return ErrWrongMode
		}
		c, err := activeCycle(ctx, q, userID)
		if err != nil {
			return err
		}
		if c == nil {
			return ledger.ErrNoActiveCycle
		}
		done, err := q.IsRefilled(ctx, sqlc.IsRefilledParams{BucketID: b.ID, CycleID: c.ID})
		if err != nil {
			return err
		}
		if done {
			return ErrAlreadyRefilled
		}
		tf, err := balance.Buckets(ctx, tx, userID)
		if err != nil {
			return err
		}
		now := s.now()
		if err := s.refill(ctx, tx, b, tf[b.ID], c.ID, sqlc.RefillModeManual, now, ""); err != nil {
			return err
		}
		return s.sweep(ctx, tx, userID, *c, b.SourceAccountID, now)
	})
}

// OnCreate marks a new bucket refilled in the active cycle, refilling it
// first, dated now, if refill is set; otherwise it holds opening funds,
// which take the refill's place. It is the buckets OnCreate hook and runs
// under the user's lock.
func (s *Service) OnCreate(ctx context.Context, tx pgx.Tx, userID, bucketID string, refill bool) error {
	q := sqlc.New(tx)
	b, err := q.GetBucketForUpdate(ctx, sqlc.GetBucketForUpdateParams{ID: bucketID, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: bucket %s", ErrNotFound, bucketID)
	}
	if err != nil {
		return err
	}
	c, err := activeCycle(ctx, q, userID)
	if err != nil {
		return err
	}
	if c == nil {
		return ledger.ErrNoActiveCycle
	}
	now := s.now()
	if refill {
		// A new bucket's TF is 0: REF = RA either way, and BC ≥ RA.
		if err := s.refill(ctx, tx, b, decimal.Zero, c.ID, sqlc.RefillModeManual, now, ""); err != nil {
			return err
		}
	} else if err := q.CreateRefill(ctx, sqlc.CreateRefillParams{
		BucketID: b.ID, CycleID: c.ID, UserID: userID, Trigger: sqlc.RefillModeManual,
	}); err != nil {
		return err
	}
	return s.sweep(ctx, tx, userID, *c, b.SourceAccountID, now)
}

// Triggers reports whether an income from counterparty of amount matches one
// of the user's income rules.
func Triggers(ctx context.Context, tx pgx.Tx, userID, counterparty string, amount decimal.Decimal) (bool, error) {
	raw, err := sqlc.New(tx).IncomeRefillRules(ctx, userID)
	if err != nil {
		return false, err
	}
	var rules []Rule
	if err := json.Unmarshal(raw, &rules); err != nil {
		return false, fmt.Errorf("income_refill_rules preference: %w", err)
	}
	counterparty = strings.TrimSpace(counterparty)
	return slices.ContainsFunc(rules, func(r Rule) bool {
		return strings.EqualFold(strings.TrimSpace(r.Counterparty), counterparty) && amount.GreaterThanOrEqual(r.MinAmount)
	}), nil
}

// OnIncome refills the On income buckets funded from accountID that haven't
// been refilled in this cycle, dated at the income's time. The income must be
// in the active cycle: if it isn't, strict returns ErrUnavailable, and
// otherwise nothing happens.
//
// A refill alone only reallocates when the account crosses Σ TF (spec §7),
// but the income is money no bucket owns, so the account is recalculated
// again with the refilled TFs.
func (s *Service) OnIncome(ctx context.Context, tx pgx.Tx, userID, incomeID, accountID string, at time.Time, strict bool) error {
	c, err := activeCycle(ctx, sqlc.New(tx), userID)
	if err != nil {
		return err
	}
	if c == nil || at.Before(c.StartAt) || !at.Before(c.EndAt) {
		if strict {
			return ErrUnavailable
		}
		return nil
	}
	if err := s.refillAll(ctx, tx, *c, sqlc.RefillModeOnIncome, accountID, at, incomeID); err != nil {
		return err
	}
	if err := allocation.Run(ctx, tx, userID, []string{accountID}, true); err != nil {
		return err
	}
	// The savings budget takes what the buckets left (#234), its fixed
	// amounts first and then the sweep (#235).
	if s.savings == nil {
		return nil
	}
	if err := s.savings.RunBudget(ctx, tx, userID, *c, sqlc.SavingsBudgetWhenOnIncome, accountID, at, incomeID); err != nil {
		return err
	}
	return s.sweep(ctx, tx, userID, *c, accountID, at)
}

// UndoIncome undoes the refills an income triggered in the active cycle: their
// REF and OVF are reversed, and the buckets can be refilled again. So are its
// savings budget runs (#234) and the sweeps on those accounts (#235). Refills in finished cycles stay; their bucket
// lines can't change. Like OnIncome, the accounts are then recalculated.
func (s *Service) UndoIncome(ctx context.Context, tx pgx.Tx, userID, incomeID string) error {
	q := sqlc.New(tx)
	c, err := activeCycle(ctx, q, userID)
	if err != nil || c == nil {
		return err
	}
	if s.savings != nil {
		if err := s.savings.UndoBudget(ctx, tx, userID, incomeID, c.ID); err != nil {
			return err
		}
	}
	refills, err := q.ListRefillsByIncome(ctx, sqlc.ListRefillsByIncomeParams{
		IncomeID: pgtype.Text{String: incomeID, Valid: true}, CycleID: c.ID,
	})
	if err != nil || len(refills) == 0 {
		return err
	}
	ids := make([]string, len(refills))
	for i, r := range refills {
		ids[i] = r.BucketID
	}
	accounts, err := q.BucketSourceAccounts(ctx, ids)
	if err != nil {
		return err
	}
	// The sweeps ran after these refills: they go first, and run again once
	// the accounts are refilled again (#235).
	if s.savings != nil {
		if err := s.savings.UndoSweeps(ctx, tx, userID, c.ID, accounts); err != nil {
			return err
		}
	}
	for _, r := range refills {
		for _, id := range []pgtype.Text{r.OvfID, r.RefID} {
			if !id.Valid {
				continue
			}
			if err := s.reverse(ctx, tx, userID, id.String); err != nil {
				return fmt.Errorf("undo the refill of bucket %s: %w", r.BucketID, err)
			}
		}
		if err := q.DeleteRefill(ctx, sqlc.DeleteRefillParams{BucketID: r.BucketID, CycleID: r.CycleID}); err != nil {
			return err
		}
	}
	return allocation.Run(ctx, tx, userID, accounts, true)
}

// refillAll refills the user's buckets with this mode that haven't been
// refilled in the cycle, optionally only those funded from accountID.
func (s *Service) refillAll(ctx context.Context, tx pgx.Tx, c sqlc.Cycle, mode sqlc.RefillMode, accountID string, at time.Time, incomeID string) error {
	if err := ledger.LockUser(ctx, tx, c.UserID); err != nil {
		return err
	}
	list, err := sqlc.New(tx).ListRefillBuckets(ctx, sqlc.ListRefillBucketsParams{
		UserID: c.UserID, Mode: mode, CycleID: c.ID, AccountID: pgtype.Text{String: accountID, Valid: accountID != ""},
	})
	if err != nil || len(list) == 0 {
		return err
	}
	tf, err := balance.Buckets(ctx, tx, c.UserID)
	if err != nil {
		return err
	}
	for _, b := range list {
		if err := s.refill(ctx, tx, b, tf[b.ID], c.ID, mode, at, incomeID); err != nil {
			return err
		}
	}
	return nil
}

// refill refills b, whose TF is tf, in the cycle:
//
//   - Keep funds off: TF is set to RA, so REF = RA − TF.
//   - Keep funds on: REF = RA, and an OVF removes what the new TF has above BC.
//     A negative TF is debt that REF pays back, unless the bucket clears it
//     (#62): then TF is set to RA, as without Keep funds.
//
// A REF or OVF of 0 isn't recorded, but the refill still counts.
func (s *Service) refill(ctx context.Context, tx pgx.Tx, b sqlc.Bucket, tf decimal.Decimal, cycleID string, trigger sqlc.RefillMode, at time.Time, incomeID string) error {
	r := sqlc.CreateRefillParams{
		BucketID: b.ID, CycleID: cycleID, UserID: b.UserID, Trigger: trigger,
		IncomeID: pgtype.Text{String: incomeID, Valid: incomeID != ""},
	}
	ref := b.RefillAmount
	if !b.KeepFunds || b.NegativeTf == sqlc.NegativeTfClear && tf.IsNegative() {
		ref = ref.Sub(tf)
	}
	if !ref.IsZero() {
		id, err := s.record(ctx, tx, b.UserID, sqlc.TransactionTypeREF, b.ID, ref, at)
		if err != nil {
			return fmt.Errorf("refill of bucket %s: %w", b.ID, err)
		}
		r.RefID = pgtype.Text{String: id, Valid: true}
	}
	// Only a Fully manual bucket, which is never refilled, has no capacity.
	bc := buckets.Capacity(b).Decimal
	if excess := tf.Add(ref).Sub(bc); b.KeepFunds && excess.IsPositive() {
		id, err := s.overflow(ctx, tx, b, excess, bc, at)
		if err != nil {
			return fmt.Errorf("overflow of bucket %s: %w", b.ID, err)
		}
		r.OvfID = pgtype.Text{String: id, Valid: true}
	}
	return sqlc.New(tx).CreateRefill(ctx, r)
}

// overflow records an OVF that takes excess off b, leaving after. The part
// of it the bucket's CAF covered, read now as earlier lines may have moved
// it, is real money: it goes where the bucket's overflow goes (#233).
func (s *Service) overflow(ctx context.Context, tx pgx.Tx, b sqlc.Bucket, excess, after decimal.Decimal, at time.Time) (string, error) {
	e := ledger.Entry{
		UserID: b.UserID, Type: sqlc.TransactionTypeOVF, At: at,
		BucketLines: []ledger.BucketLine{{BucketID: b.ID, Amount: excess.Neg()}},
	}
	if s.savings != nil && b.OverflowDestination != sqlc.OverflowDestinationUnallocated {
		cur, err := sqlc.New(tx).GetBucketForUpdate(ctx, sqlc.GetBucketForUpdateParams{ID: b.ID, UserID: b.UserID})
		if err != nil {
			return "", err
		}
		funded := decimal.Min(decimal.Max(cur.Caf.Sub(after), decimal.Zero), excess)
		if e.SavingsLines, err = s.savings.OverflowLines(ctx, tx, b.UserID, cur, funded); err != nil {
			return "", err
		}
	}
	t, err := s.ledger.Record(ctx, tx, e)
	if err != nil {
		return "", err
	}
	if len(e.SavingsLines) > 0 {
		if err := s.savings.AfterOverflow(ctx, tx, b.UserID, b.SourceAccountID, t.Header.ID, at, e.SavingsLines); err != nil {
			return "", err
		}
	}
	return t.Header.ID, nil
}

// record records a system transaction with one bucket line.
func (s *Service) record(ctx context.Context, tx pgx.Tx, userID string, typ sqlc.TransactionType, bucketID string, amount decimal.Decimal, at time.Time) (string, error) {
	t, err := s.ledger.Record(ctx, tx, ledger.Entry{
		UserID: userID, Type: typ, At: at,
		BucketLines: []ledger.BucketLine{{BucketID: bucketID, Amount: amount}},
	})
	if err != nil {
		return "", err
	}
	return t.Header.ID, nil
}

// reverse reverses a REF or OVF the routine recorded, dated at its time.
func (s *Service) reverse(ctx context.Context, tx pgx.Tx, userID, id string) error {
	t, err := ledger.Get(ctx, tx, userID, id)
	if err != nil {
		return err
	}
	e := ledger.Entry{
		UserID: userID, Type: t.Header.TransactionType, Correction: sqlc.CorrectionTypeReversal,
		ParentID: id, At: t.Header.TransactionAt,
	}
	for _, l := range t.BucketLines {
		e.BucketLines = append(e.BucketLines, ledger.BucketLine{BucketID: l.BucketID, Amount: l.Amount.Neg()})
	}
	// An overflow's savings come back the way they went (#233): what it
	// moved on is taken back first, then what's held is released, each as
	// far as the money is still there.
	if len(t.SavingsLines) > 0 && s.savings != nil {
		if e.SavingsLines, err = s.savings.ReleaseOverflow(ctx, tx, userID, t); err != nil {
			return err
		}
	}
	_, err = s.ledger.Record(ctx, tx, e)
	return err
}

// activeCycle returns the user's active cycle, or nil.
func activeCycle(ctx context.Context, q *sqlc.Queries, userID string) (*sqlc.Cycle, error) {
	c, err := q.GetActiveCycle(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil //nolint:nilnil // no active cycle isn't an error here
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}
