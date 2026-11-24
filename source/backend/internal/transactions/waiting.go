package transactions

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cards"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
)

// Counting a purchase in its bucket later (#264, spec §5.5): see the ledger's
// waiting.go for the lines.

var (
	// ErrChargeTaken means a bucket has already taken (part of) the
	// purchase where the change can't undo it: in a finished cycle, or more
	// than the change leaves.
	ErrChargeTaken = ledger.ErrChargeTaken
	// ErrChargeClosed means a waiting charge has nothing left to take, or its
	// bucket is gone.
	ErrChargeClosed = errors.New("nothing is left for the bucket to take")
	// ErrCardOnly means a purchase can wait until it's paid off only on a
	// credit card.
	ErrCardOnly = errors.New("only a credit card purchase can count as it's paid off")
)

func waitingCharge(c sqlc.WaitingChargesForRow) WaitingCharge {
	w := WaitingCharge{
		ID: c.ID, BucketID: c.BucketID, When: c.When, CycleID: c.CycleID.String,
		Part: c.Part, Left: c.LeftAmount, BucketDeleted: c.BucketDeleted,
	}
	if c.TakeOn.Valid {
		w.TakeOn = c.TakeOn.Time
	}
	return w
}

// rule returns the purchase's CountLater, from its waiting charges, or nil
// when it counts now.
func (t Transaction) rule() *CountLater {
	if len(t.Waiting) == 0 {
		return nil
	}
	w := t.Waiting[0]
	r := &CountLater{When: w.When, CycleID: w.CycleID}
	if w.When == sqlc.WaitingChargeWhenMonth {
		r.Month = w.TakeOn
	}
	if w.When == sqlc.WaitingChargeWhenCycle && w.CycleID == "" {
		// Its cycle was deleted: the first cycle from its start date.
		r.When, r.Month = sqlc.WaitingChargeWhenMonth, w.TakeOn
	}
	return r
}

// ownWaiting returns the purchase's own parts: its waiting lines for itself.
func (t Transaction) ownWaiting() []WaitingLine {
	return filter(t.WaitingLines, func(l WaitingLine) bool { return l.PurchaseID == t.ID })
}

// takeOn checks a CountLater for an expense on account and returns the date
// its charges are taken from (invalid for paid).
func takeOn(ctx context.Context, q *sqlc.Queries, userID, account string, n New) (pgtype.Date, error) {
	r := n.CountLater
	if n.Type != sqlc.TransactionTypeEXP || len(n.Buckets) == 0 {
		return pgtype.Date{}, fmt.Errorf("%w: only an expense's bucket parts can count in their buckets later", ErrInvalid)
	}
	switch r.When {
	case sqlc.WaitingChargeWhenPaid:
		rows, err := q.GetOwnedAccounts(ctx, sqlc.GetOwnedAccountsParams{Ids: []string{account}, UserID: userID})
		if err != nil {
			return pgtype.Date{}, err
		}
		if len(rows) != 1 || rows[0].AccountType != sqlc.AccountTypeCreditCard {
			return pgtype.Date{}, ErrCardOnly
		}
		return pgtype.Date{}, nil
	case sqlc.WaitingChargeWhenCycle:
		c, err := q.GetCycle(ctx, sqlc.GetCycleParams{ID: r.CycleID, UserID: userID})
		if errors.Is(err, pgx.ErrNoRows) {
			return pgtype.Date{}, fmt.Errorf("%w: cycle %s doesn't exist", ErrInvalid, r.CycleID)
		}
		if err != nil {
			return pgtype.Date{}, err
		}
		if c.State != sqlc.CycleStateFuture {
			return pgtype.Date{}, fmt.Errorf("%w: a purchase can count only in a planned cycle", ErrInvalid)
		}
		loc, err := cards.Location(ctx, q, userID)
		if err != nil {
			return pgtype.Date{}, err
		}
		y, m, d := c.StartAt.In(loc).Date()
		return pgtype.Date{Time: time.Date(y, m, d, 0, 0, 0, 0, time.UTC), Valid: true}, nil
	case sqlc.WaitingChargeWhenMonth:
		y, m, _ := r.Month.Date()
		first := time.Date(y, m, 1, 0, 0, 0, 0, time.UTC)
		active, err := q.GetActiveCycle(ctx, userID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return pgtype.Date{}, err
		}
		if err == nil {
			loc, err := cards.Location(ctx, q, userID)
			if err != nil {
				return pgtype.Date{}, err
			}
			ay, am, _ := active.StartAt.In(loc).Date()
			if !first.After(time.Date(ay, am, 1, 0, 0, 0, 0, time.UTC)) {
				return pgtype.Date{}, fmt.Errorf("%w: the month must be after the active cycle's start", ErrInvalid)
			}
		}
		return pgtype.Date{Time: first, Valid: true}, nil
	}
	return pgtype.Date{}, fmt.Errorf("%w: count in bucket %q", ErrInvalid, r.When)
}

// waitingParts returns an expense's bucket parts as waiting lines of its
// own family.
func waitingParts(n New) []ledger.WaitingLine {
	out := make([]ledger.WaitingLine, len(n.Buckets))
	for i, b := range n.Buckets {
		out[i] = ledger.WaitingLine{BucketID: b.BucketID, Amount: b.Amount}
	}
	return out
}

// settleWaiting brings a purchase's waiting charges in line with n after
// its lines were recorded: a charge per bucket, all with n's rule taken from
// on. Each bucket must still owe what it hasn't taken (ErrChargeTaken
// otherwise), and a card purchase paid off already is taken at once.
func (s *Service) settleWaiting(ctx context.Context, tx pgx.Tx, userID, purchaseID string, n New, on pgtype.Date) error {
	q := sqlc.New(tx)
	r := n.CountLater
	cycle := pgtype.Text{String: r.CycleID, Valid: r.When == sqlc.WaitingChargeWhenCycle}
	if err := q.SetWaitingRule(ctx, sqlc.SetWaitingRuleParams{
		TransactionID: purchaseID, When: r.When, CycleID: cycle, TakeOn: on,
	}); err != nil {
		return err
	}
	have, err := q.WaitingChargesFor(ctx, []string{purchaseID})
	if err != nil {
		return err
	}
	for _, b := range n.Buckets {
		if slices.ContainsFunc(have, func(c sqlc.WaitingChargesForRow) bool { return c.BucketID == b.BucketID }) {
			continue
		}
		if _, err := ids.Insert(ctx, ids.WaitingCharge, func() string { return ids.NewWaitingCharge(b.BucketID) },
			func(ctx context.Context, id string) (bool, error) {
				_, err := q.CreateWaitingCharge(ctx, sqlc.CreateWaitingChargeParams{
					ID: id, UserID: userID, TransactionID: purchaseID, BucketID: b.BucketID,
					When: r.When, CycleID: cycle, TakeOn: on,
				})
				return ids.Inserted(err)
			}); err != nil {
			return fmt.Errorf("create waiting charge: %w", err)
		}
	}
	for _, c := range have {
		if c.LeftAmount.IsNegative() {
			return ErrChargeTaken
		}
	}
	if r.When != sqlc.WaitingChargeWhenPaid {
		return nil
	}
	return s.ledger.SyncPaid(ctx, tx, userID, []string{n.AccountID}, s.now(), userID)
}

// Take takes what's left of a waiting charge now (#264): the bucket counts
// it in the active cycle. It returns the purchase.
func (s *Service) Take(ctx context.Context, userID, chargeID string) (Transaction, error) {
	var purchase string
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		c, err := q.GetWaitingCharge(ctx, sqlc.GetWaitingChargeParams{ID: chargeID, UserID: userID})
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("%w: waiting charge %s", ErrNotFound, chargeID)
		}
		if err != nil {
			return err
		}
		purchase = c.TransactionID
		if c.BucketDeleted || !c.LeftAmount.IsPositive() {
			return ErrChargeClosed
		}
		active, err := q.GetActiveCycle(ctx, userID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ledger.ErrNoActiveCycle
		}
		if err != nil {
			return err
		}
		at := s.now()
		if last := active.EndAt.Add(-time.Microsecond); at.After(last) {
			at = last
		}
		_, err = s.ledger.TakeWaiting(ctx, tx, ledger.Take{
			UserID: userID, CreatedBy: userID, PurchaseID: c.TransactionID, BucketID: c.BucketID,
			Amount: c.LeftAmount, At: at,
		})
		return err
	})
	if err != nil {
		return Transaction{}, err
	}
	return s.Get(ctx, userID, purchase)
}

// OpenCharge is a waiting charge with something left on a live bucket.
type OpenCharge struct {
	ID         string
	PurchaseID string
	BucketID   string
	// AccountID is the bucket's account, where the advance is.
	AccountID string
	When      sqlc.WaitingChargeWhen
	CycleID   string
	TakeOn    time.Time
	// At and Counterparty are the purchase's.
	At           time.Time
	Counterparty string
	Left         decimal.Decimal
}

// Waiting lists the user's open waiting charges, oldest purchase first;
// with accountID, only those of buckets on it.
func (s *Service) Waiting(ctx context.Context, userID, accountID string) ([]OpenCharge, error) {
	rows, err := sqlc.New(s.pool).ListOpenWaitingCharges(ctx, sqlc.ListOpenWaitingChargesParams{
		UserID: userID, AccountID: text(accountID),
	})
	if err != nil {
		return nil, err
	}
	out := make([]OpenCharge, len(rows))
	for i, r := range rows {
		out[i] = OpenCharge{
			ID: r.ID, PurchaseID: r.TransactionID, BucketID: r.BucketID, AccountID: r.SourceAccountID,
			When: r.When, CycleID: r.CycleID.String, At: r.TransactionAt, Counterparty: r.Counterparty, Left: r.LeftAmount,
		}
		if r.TakeOn.Valid {
			out[i].TakeOn = r.TakeOn.Time
		}
	}
	return out, nil
}
