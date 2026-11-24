package ledger

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
)

// Counting a purchase in its bucket later (#264, spec §5.5). An expense's
// bucket parts can wait: each is a waiting line (+) on its bucket, an advance
// the bucket owes its account. A DBC takes it, in parts or at once, with a
// bucket line (−) as an expense's and a waiting line (−) that pays the advance
// back. What a bucket still owes for a purchase is the sum of their waiting
// lines.

// ErrChargeTaken means a bucket has already taken (part of) a waiting
// purchase in a finished cycle, so the change can't undo it.
var ErrChargeTaken = errors.New("a bucket has already taken this purchase in a finished cycle")

// Take is a DBC: a bucket taking Amount of a purchase that waits for it.
type Take struct {
	UserID string
	// CreatedBy is the user who took it, or "" for the system (at a cycle's
	// start).
	CreatedBy  string
	PurchaseID string
	BucketID   string
	Amount     decimal.Decimal
	At         time.Time
}

// TakeWaiting records a DBC in tx: the bucket takes k.Amount of what it
// owes for the purchase, in the active cycle, with the purchase's effective
// counterparty, description and tags.
func (l *Ledger) TakeWaiting(ctx context.Context, tx pgx.Tx, k Take) (*Transaction, error) {
	newest, err := sqlc.New(tx).NewestInFamily(ctx, sqlc.NewestInFamilyParams{ID: k.PurchaseID, UserID: k.UserID})
	if err != nil {
		return nil, err
	}
	p, err := Get(ctx, tx, k.UserID, newest.ID)
	if err != nil {
		return nil, err
	}
	return l.Record(ctx, tx, Entry{
		UserID: k.UserID, CreatedBy: k.CreatedBy, Type: sqlc.TransactionTypeDBC, At: k.At,
		Counterparty: p.Header.Counterparty, Description: p.Header.Description, Tags: p.Tags,
		BucketLines:  []BucketLine{{BucketID: k.BucketID, Amount: k.Amount.Neg()}},
		WaitingLines: []WaitingLine{{PurchaseID: k.PurchaseID, BucketID: k.BucketID, Amount: k.Amount.Neg()}},
	})
}

// inCycle returns at moved into the cycle c: no earlier than its start and
// before its end.
func inCycle(at time.Time, c sqlc.Cycle) time.Time {
	if at.Before(c.StartAt) {
		return c.StartAt
	}
	if last := c.EndAt.Add(-time.Microsecond); at.After(last) {
		return last
	}
	return at
}

// activeCycleOf returns the user's active cycle, or false without one.
func activeCycleOf(ctx context.Context, q *sqlc.Queries, userID string) (sqlc.Cycle, bool, error) {
	c, err := q.GetActiveCycle(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return sqlc.Cycle{}, false, nil
	}
	return c, err == nil, err
}

// TakeDue takes the waiting charges due at the start of cycle c, which has
// just become active: those for c, and those for a month (or a deleted
// cycle) from on or before its start. Then it catches up the card purchases
// paid off while there was no active cycle. It's part of the cycle start
// routine, after the refills and the savings budget, so it's dated at the
// cycle's start and done by the system.
func (l *Ledger) TakeDue(ctx context.Context, tx pgx.Tx, c sqlc.Cycle, loc *time.Location) error {
	q := sqlc.New(tx)
	y, m, d := c.StartAt.In(loc).Date()
	due, err := q.DueWaitingCharges(ctx, sqlc.DueWaitingChargesParams{
		UserID: c.UserID, CycleID: c.ID, StartDate: time.Date(y, m, d, 0, 0, 0, 0, time.UTC),
	})
	if err != nil {
		return err
	}
	for _, w := range due {
		if _, err := l.TakeWaiting(ctx, tx, Take{
			UserID: c.UserID, PurchaseID: w.TransactionID, BucketID: w.BucketID, Amount: w.LeftAmount, At: c.StartAt,
		}); err != nil {
			return fmt.Errorf("take waiting charge %s: %w", w.ID, err)
		}
	}
	return l.SyncPaid(ctx, tx, c.UserID, nil, c.StartAt, "")
}

// SyncPaid brings the buckets' takes of card purchases that wait until
// they're paid off in line with what's paid of them, on these cards (all the
// user's for nil): in the active cycle, dated at at (moved into it), done by
// createdBy. Without an active cycle, it waits for the next cycle's start.
//
// Payments clear a card's debt oldest first: a purchase is paid by what the
// card's payments and refunds (everything above 0) leave after the debt
// before it, up to its amount, and its waiting parts share that pro rata.
// What's paid and not taken is taken; what's taken and no longer paid (a
// payment reversed) is given back by reversing the newest takes in the
// active cycle.
func (l *Ledger) SyncPaid(ctx context.Context, tx pgx.Tx, userID string, cards []string, at time.Time, createdBy string) error {
	q := sqlc.New(tx)
	charges, err := q.PaidWaitingCharges(ctx, sqlc.PaidWaitingChargesParams{UserID: userID, CardIds: cards})
	if err != nil || len(charges) == 0 {
		return err
	}
	c, ok, err := activeCycleOf(ctx, q, userID)
	if err != nil || !ok {
		return err
	}
	at = inCycle(at, c)
	paid := map[string]decimal.Decimal{}   // purchase → what's paid of it
	amount := map[string]decimal.Decimal{} // purchase → its debt
	seen := map[string]bool{}
	for _, w := range charges {
		if seen[w.CardID] {
			continue
		}
		seen[w.CardID] = true
		nets, err := q.CardFamilyNets(ctx, w.CardID)
		if err != nil {
			return err
		}
		credit := decimal.Zero
		for _, n := range nets {
			if n.Net.IsPositive() {
				credit = credit.Add(n.Net)
			}
		}
		debt := decimal.Zero // before this family
		for _, n := range nets {
			if !n.Net.IsNegative() {
				continue
			}
			a := n.Net.Neg()
			amount[n.ID] = a
			paid[n.ID] = decimal.Max(decimal.Zero, decimal.Min(a, credit.Sub(debt)))
			debt = debt.Add(a)
		}
	}
	for _, w := range charges {
		if w.BucketDeleted {
			continue
		}
		target := decimal.Zero
		if a := amount[w.TransactionID]; a.IsPositive() && w.Part.IsPositive() {
			target = money.Round(w.Part.Mul(paid[w.TransactionID]).Div(a))
			target = decimal.Min(target, w.Part)
		}
		taken := w.Part.Sub(w.LeftAmount)
		if taken.GreaterThan(target) {
			if taken, err = l.giveBack(ctx, tx, userID, w.TransactionID, w.BucketID, taken, target, c, false); err != nil {
				return err
			}
		}
		if taken.LessThan(target) {
			if _, err := l.TakeWaiting(ctx, tx, Take{
				UserID: userID, CreatedBy: createdBy, PurchaseID: w.TransactionID, BucketID: w.BucketID,
				Amount: target.Sub(taken), At: at,
			}); err != nil {
				return fmt.Errorf("take waiting charge %s: %w", w.ID, err)
			}
		}
	}
	return nil
}

// giveBack reverses a purchase's takes for a bucket, newest first, while
// more than target is taken, and returns what's taken after. Only takes in
// the active cycle c can be reversed; with strict, one in an earlier cycle
// is ErrChargeTaken, otherwise it stays.
func (l *Ledger) giveBack(ctx context.Context, tx pgx.Tx, userID, purchaseID, bucketID string,
	taken, target decimal.Decimal, c sqlc.Cycle, strict bool,
) (decimal.Decimal, error) {
	takes, err := sqlc.New(tx).WaitingTakes(ctx, sqlc.WaitingTakesParams{PurchaseID: purchaseID, BucketID: bucketID})
	if err != nil {
		return taken, err
	}
	for _, k := range takes {
		if !taken.GreaterThan(target) {
			break
		}
		if k.TransactionAt.Before(c.StartAt) {
			if strict {
				return taken, ErrChargeTaken
			}
			break
		}
		if _, err := l.Record(ctx, tx, Entry{
			UserID: userID, Type: sqlc.TransactionTypeDBC, Correction: sqlc.CorrectionTypeReversal, ParentID: k.ID,
			At: k.TransactionAt, Counterparty: k.Counterparty, Description: k.Description,
			BucketLines:  []BucketLine{{BucketID: bucketID, Amount: k.Taken}},
			WaitingLines: []WaitingLine{{PurchaseID: purchaseID, BucketID: bucketID, Amount: k.Taken}},
		}); err != nil {
			return taken, fmt.Errorf("give back take %s: %w", k.ID, err)
		}
		taken = taken.Sub(k.Taken)
	}
	return taken, nil
}

// UndoTakes reverses every take of a purchase's waiting charges, for
// reversing or moving the purchase. A take in a finished cycle can't be
// undone: that's ErrChargeTaken.
func (l *Ledger) UndoTakes(ctx context.Context, tx pgx.Tx, userID, purchaseID string) error {
	q := sqlc.New(tx)
	charges, err := q.WaitingChargesFor(ctx, []string{purchaseID})
	if err != nil {
		return err
	}
	var c sqlc.Cycle
	for _, w := range charges {
		taken := w.Part.Sub(w.LeftAmount)
		if !taken.IsPositive() {
			continue
		}
		if c.ID == "" {
			var ok bool
			if c, ok, err = activeCycleOf(ctx, q, userID); err != nil {
				return err
			} else if !ok {
				return ErrChargeTaken
			}
		}
		if _, err := l.giveBack(ctx, tx, userID, purchaseID, w.BucketID, taken, decimal.Zero, c, true); err != nil {
			return err
		}
	}
	return nil
}
