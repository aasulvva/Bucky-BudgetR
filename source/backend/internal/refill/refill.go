// Package refill holds the cycle routines (spec §6): refilling buckets with a
// REF, and removing what doesn't roll over with an OVF.
//
// A bucket is refilled at most once per cycle, according to its refill mode:
//
//   - Auto: at cycle start (OnStart, a cycles hook).
//   - Manual: when the user asks (Manual).
//   - On income: when an income triggers it (OnIncome, called by the
//     transactions service). Reversing the income undoes it (UndoIncome).
//
// A bucket created in the active cycle with a refill or opening funds counts
// as refilled in it, whatever its mode (OnCreate, a buckets hook).
//
// At cycle end (OnEnd), buckets without Keep funds are emptied.
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

// Options configures a Service.
type Options struct {
	// Now returns the current time. Defaults to time.Now.
	Now func() time.Time
}

// Service runs the cycle routines.
type Service struct {
	pool   *pgxpool.Pool
	ledger *ledger.Ledger
	now    func() time.Time
}

// NewService returns a Service.
func NewService(pool *pgxpool.Pool, l *ledger.Ledger, opts Options) *Service {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Service{pool: pool, ledger: l, now: opts.Now}
}

// OnStart refills the Auto buckets, dated at the cycle's start. It is the
// cycles OnStart hook.
func (s *Service) OnStart(ctx context.Context, tx pgx.Tx, c sqlc.Cycle) error {
	return s.refillAll(ctx, tx, c, sqlc.RefillModeAuto, "", c.StartAt, "")
}

// OnEnd empties the buckets without Keep funds: an OVF brings a positive TF
// to 0. It first brings CAF up to date, so the funded part is known. It is
// the cycles OnEnd hook and runs while the cycle is still active.
func (s *Service) OnEnd(ctx context.Context, tx pgx.Tx, c sqlc.Cycle) error {
	if err := ledger.LockUser(ctx, tx, c.UserID); err != nil {
		return err
	}
	accounts, err := balance.Accounts(ctx, tx, c.UserID)
	if err != nil {
		return err
	}
	if err := allocation.Run(ctx, tx, c.UserID, slices.Sorted(maps.Keys(accounts)), true); err != nil {
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
		if _, err := s.record(ctx, tx, c.UserID, sqlc.TransactionTypeOVF, b.ID, tf[b.ID].Neg(), at); err != nil {
			return fmt.Errorf("overflow of bucket %s: %w", b.ID, err)
		}
	}
	return nil
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
		return s.refill(ctx, tx, b, tf[b.ID], c.ID, sqlc.RefillModeManual, s.now(), "")
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
	if refill {
		// A new bucket's TF is 0: REF = RA either way, and BC ≥ RA.
		return s.refill(ctx, tx, b, decimal.Zero, c.ID, sqlc.RefillModeManual, s.now(), "")
	}
	return q.CreateRefill(ctx, sqlc.CreateRefillParams{
		BucketID: b.ID, CycleID: c.ID, UserID: userID, Trigger: sqlc.RefillModeManual,
	})
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
	return s.refillAll(ctx, tx, *c, sqlc.RefillModeOnIncome, accountID, at, incomeID)
}

// UndoIncome undoes the refills an income triggered in the active cycle: their
// REF and OVF are reversed, and the buckets can be refilled again. Refills in
// finished cycles stay; their bucket lines can't change.
func (s *Service) UndoIncome(ctx context.Context, tx pgx.Tx, userID, incomeID string) error {
	q := sqlc.New(tx)
	c, err := activeCycle(ctx, q, userID)
	if err != nil || c == nil {
		return err
	}
	refills, err := q.ListRefillsByIncome(ctx, sqlc.ListRefillsByIncomeParams{
		IncomeID: pgtype.Text{String: incomeID, Valid: true}, CycleID: c.ID,
	})
	if err != nil {
		return err
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
	return nil
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
//
// A REF or OVF of 0 isn't recorded, but the refill still counts.
func (s *Service) refill(ctx context.Context, tx pgx.Tx, b sqlc.Bucket, tf decimal.Decimal, cycleID string, trigger sqlc.RefillMode, at time.Time, incomeID string) error {
	r := sqlc.CreateRefillParams{
		BucketID: b.ID, CycleID: cycleID, UserID: b.UserID, Trigger: trigger,
		IncomeID: pgtype.Text{String: incomeID, Valid: incomeID != ""},
	}
	ref := b.RefillAmount
	if !b.KeepFunds {
		ref = ref.Sub(tf)
	}
	if !ref.IsZero() {
		id, err := s.record(ctx, tx, b.UserID, sqlc.TransactionTypeREF, b.ID, ref, at)
		if err != nil {
			return fmt.Errorf("refill of bucket %s: %w", b.ID, err)
		}
		r.RefID = pgtype.Text{String: id, Valid: true}
	}
	if excess := tf.Add(ref).Sub(buckets.Capacity(b)); b.KeepFunds && excess.IsPositive() {
		id, err := s.record(ctx, tx, b.UserID, sqlc.TransactionTypeOVF, b.ID, excess.Neg(), at)
		if err != nil {
			return fmt.Errorf("overflow of bucket %s: %w", b.ID, err)
		}
		r.OvfID = pgtype.Text{String: id, Valid: true}
	}
	return sqlc.New(tx).CreateRefill(ctx, r)
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
