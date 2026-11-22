package savings

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/balance"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
)

// Bucket overflow to savings (#233, spec §8.5): the refill routine asks for
// an overflow's savings lines, records them on its OVF, and then lets the
// savings move on (AfterOverflow), remembering what it moved them on with.
// Undoing a refill takes that back first and then releases what's held
// (ReleaseOverflow): the money follows its way back as far as it can.

// OverflowLines are the savings lines an overflow of bucket b records for
// funded, the part of it the bucket's CAF covered. They hold the money on
// the bucket's source account:
//
//   - unallocated: none;
//   - savings_distribution: all of it for the distributor;
//   - savings_target: up to the target's room below its goal (unless the
//     rule at its position goes past it) and a bucket target's fixed BC, and
//     the rest for the distributor.
//
// An account target that is the bucket's own account already has the money,
// so it gets no line. Run it after LockUser.
func (s *Service) OverflowLines(ctx context.Context, tx pgx.Tx, userID string, b sqlc.Bucket, funded decimal.Decimal) ([]ledger.SavingsLine, error) {
	switch b.OverflowDestination {
	case sqlc.OverflowDestinationSavingsDistribution:
		return s.holdLines(ctx, tx, userID, b.SourceAccountID, "", funded)
	case sqlc.OverflowDestinationSavingsTarget:
		return s.holdLines(ctx, tx, userID, b.SourceAccountID, b.OverflowTargetID.String, funded)
	default:
		return nil, nil
	}
}

// holdLines are the savings lines that hold amount on the account for the
// target, or the distributor when targetID is "": the target takes up to its
// room (overflowRoom), and the distributor the rest. A target that's gone
// leaves it all to the distributor; an account target that is the account
// itself already has the money, so it gets no line. Run it after LockUser.
func (s *Service) holdLines(ctx context.Context, tx pgx.Tx, userID, accountID, targetID string, amount decimal.Decimal) ([]ledger.SavingsLine, error) {
	if !amount.IsPositive() {
		return nil, nil
	}
	toTarget := decimal.Zero
	if targetID != "" {
		targets, err := list(ctx, tx, userID)
		if err != nil {
			return nil, err
		}
		i := slices.IndexFunc(targets, func(t Target) bool { return t.ID == targetID })
		if i >= 0 {
			t := targets[i]
			if t.AccountID == accountID {
				return nil, nil
			}
			room, err := s.overflowRoom(ctx, tx, userID, t)
			if err != nil {
				return nil, err
			}
			toTarget = amount
			if room != nil && room.LessThan(toTarget) {
				toTarget = decimal.Max(*room, decimal.Zero)
			}
		}
	}
	var lines []ledger.SavingsLine
	if toTarget.IsPositive() {
		lines = append(lines, ledger.SavingsLine{HolderID: targetID, AccountID: accountID, Amount: toTarget})
	}
	if rest := amount.Sub(toTarget); rest.IsPositive() {
		d, err := ensureDistributor(ctx, tx, userID)
		if err != nil {
			return nil, err
		}
		lines = append(lines, ledger.SavingsLine{HolderID: d.ID, AccountID: accountID, Amount: rest})
	}
	return lines, nil
}

// overflowRoom is how much more the target can take from overflow or the
// savings budget: up to its
// goal unless the rule at its position goes past it, and never past a bucket
// target's fixed BC; nil for no limit.
func (s *Service) overflowRoom(ctx context.Context, tx pgx.Tx, userID string, t Target) (*decimal.Decimal, error) {
	q := sqlc.New(tx)
	c := Candidate{ID: t.ID, Position: decimal.Max(t.Current, decimal.Zero).Add(t.HeldTotal()), Goal: t.Goal}
	if t.BucketID != "" {
		b, err := q.GetBucket(ctx, sqlc.GetBucketParams{ID: t.BucketID, UserID: userID})
		if err != nil {
			return nil, notFound(err, "bucket", t.BucketID)
		}
		if bc := buckets.Capacity(b.Bucket); bc.Valid {
			c.Capacity = &bc.Decimal
		}
	}
	rules, err := q.ListSavingsRules(ctx, userID)
	if err != nil {
		return nil, err
	}
	for _, r := range rules {
		if r.TargetID == t.ID {
			c.Rules = append(c.Rules, ruleOf(r))
		}
	}
	r, _ := ruleAt(c.Rules, c.Position)
	ceil := hardCap(c, r)
	if ceil == nil {
		return nil, nil //nolint:nilnil // no limit
	}
	room := ceil.Sub(c.Position)
	return &room, nil
}

// AfterOverflow moves savings just held by source (an OVF, or a savings
// budget SVR) on, in its transaction: a bucket target funded from the
// account gets its share straight into the bucket (an SVB at the same time,
// while a cycle holds it), and the distributor splits by its hold mode. The
// SVB and SVD are recorded as source's follow-ons, for ReleaseOverflow.
func (s *Service) AfterOverflow(ctx context.Context, tx pgx.Tx, userID, accountID, sourceID string, at time.Time, lines []ledger.SavingsLine) error {
	q := sqlc.New(tx)
	follow := func(id string) error {
		return q.CreateFollowOn(ctx, sqlc.CreateFollowOnParams{SourceID: sourceID, FollowID: id, UserID: userID})
	}
	distributor := false
	for _, l := range lines {
		h, err := q.GetSavingsHolderForUpdate(ctx, sqlc.GetSavingsHolderForUpdateParams{ID: l.HolderID, UserID: userID})
		if err != nil {
			return err
		}
		if h.Kind == sqlc.SavingsHolderKindDistributor {
			distributor = true
			continue
		}
		if !h.BucketID.Valid {
			continue
		}
		b, err := q.GetBucketForUpdate(ctx, sqlc.GetBucketForUpdateParams{ID: h.BucketID.String, UserID: userID})
		if err != nil {
			return notFound(err, "bucket", h.BucketID.String)
		}
		if b.SourceAccountID != accountID {
			continue
		}
		ok, err := inActiveCycle(ctx, q, userID, at)
		if err != nil || !ok {
			return err
		}
		svb, err := s.ledger.Record(ctx, tx, ledger.Entry{
			UserID: userID, Type: sqlc.TransactionTypeSVB, At: at,
			SavingsLines: []ledger.SavingsLine{{HolderID: h.ID, AccountID: accountID, Amount: l.Amount.Neg()}},
			BucketLines:  []ledger.BucketLine{{BucketID: b.ID, Amount: l.Amount}},
		})
		if err != nil {
			return err
		}
		if err := follow(svb.Header.ID); err != nil {
			return err
		}
	}
	if distributor {
		svds, err := s.Incoming(ctx, tx, userID, accountID)
		if err != nil {
			return err
		}
		for _, id := range svds {
			if err := follow(id); err != nil {
				return err
			}
		}
	}
	return nil
}

// ReleaseOverflow undoes what the overflow (or savings budget SVR) t moved
// on (its follow-ons, see takeBack), and returns what reversing t can then
// take off hold: each of its savings lines, but no more than its holder
// still holds on the account. What was moved at the bank (Done) or cleared
// stays as it is.
func (s *Service) ReleaseOverflow(ctx context.Context, tx pgx.Tx, userID string, t *ledger.Transaction) ([]ledger.SavingsLine, error) {
	if err := s.takeBack(ctx, tx, userID, t); err != nil {
		return nil, err
	}
	var out []ledger.SavingsLine
	for _, l := range t.SavingsLines {
		if !l.Amount.IsPositive() {
			continue
		}
		held, err := s.heldNow(ctx, tx, l.HolderID, l.AccountID)
		if err != nil {
			return nil, err
		}
		if a := decimal.Min(l.Amount, held); a.IsPositive() {
			out = append(out, ledger.SavingsLine{HolderID: l.HolderID, AccountID: l.AccountID, Amount: a.Neg()})
		}
	}
	return out, nil
}

// inActiveCycle reports whether the user's active cycle holds at.
func inActiveCycle(ctx context.Context, q *sqlc.Queries, userID string, at time.Time) (bool, error) {
	c, err := q.GetActiveCycle(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return !at.Before(c.StartAt) && at.Before(c.EndAt), nil
}

// takeBack reverses source's follow-ons, newest first, each dated at its own
// time, as far as the money is still there:
//
//   - an SVB straight into a bucket target: back to the target's hold, at
//     most the bucket's TF;
//   - an SVD: back to the distributor, the share of it that source's money
//     was (an SVD splits everything the distributor held on the account),
//     each target at most what it still holds there and each bucket target
//     at most its TF.
//
// A deleted target or bucket keeps its share.
func (s *Service) takeBack(ctx context.Context, tx pgx.Tx, userID string, source *ledger.Transaction) error {
	q := sqlc.New(tx)
	ids, err := q.ListFollowOns(ctx, sqlc.ListFollowOnsParams{SourceID: source.Header.ID, UserID: userID})
	if err != nil || len(ids) == 0 {
		return err
	}
	for _, id := range ids {
		f, err := ledger.Get(ctx, tx, userID, id)
		if err != nil {
			return err
		}
		share := decimal.NewFromInt(1)
		if f.Header.TransactionType == sqlc.TransactionTypeSVD {
			share = svdShare(source, f)
		}
		e := ledger.Entry{
			UserID: userID, Type: f.Header.TransactionType, Correction: sqlc.CorrectionTypeReversal,
			ParentID: f.Header.ID, At: f.Header.TransactionAt,
		}
		// The one line that paid out in f gets it back.
		var payer *sqlc.SavingsTransaction
		for i, l := range f.SavingsLines {
			if l.Amount.IsNegative() {
				if payer != nil {
					payer = nil
					break
				}
				payer = &f.SavingsLines[i]
			}
		}
		if payer == nil {
			continue // not a shape the routines record
		}
		back := decimal.Zero
		for _, l := range f.SavingsLines {
			if !l.Amount.IsPositive() {
				continue
			}
			a := l.Amount.Mul(share).RoundFloor(2)
			held, err := s.liveHeld(ctx, tx, userID, l.HolderID, l.AccountID)
			if err != nil {
				return err
			}
			if a = decimal.Min(a, held); a.IsPositive() {
				e.SavingsLines = append(e.SavingsLines, ledger.SavingsLine{HolderID: l.HolderID, AccountID: l.AccountID, Amount: a.Neg()})
				back = back.Add(a)
			}
		}
		if len(f.BucketLines) > 0 {
			tfs, err := balance.Buckets(ctx, tx, userID)
			if err != nil {
				return err
			}
			for _, l := range f.BucketLines {
				if !l.Amount.IsPositive() {
					continue
				}
				b, err := q.GetBucketForUpdate(ctx, sqlc.GetBucketForUpdateParams{ID: l.BucketID, UserID: userID})
				if errors.Is(err, pgx.ErrNoRows) || (err == nil && b.Deleted) {
					continue
				}
				if err != nil {
					return err
				}
				a := decimal.Min(l.Amount.Mul(share).RoundFloor(2), decimal.Max(tfs[l.BucketID], decimal.Zero))
				if a.IsPositive() {
					e.BucketLines = append(e.BucketLines, ledger.BucketLine{BucketID: l.BucketID, Amount: a.Neg()})
					back = back.Add(a)
				}
			}
		}
		if !back.IsPositive() {
			continue
		}
		e.SavingsLines = append([]ledger.SavingsLine{{HolderID: payer.HolderID, AccountID: payer.AccountID, Amount: back}}, e.SavingsLines...)
		if _, err := s.ledger.Record(ctx, tx, e); err != nil {
			return err
		}
	}
	return nil
}

// svdShare is the part of the SVD f that source's money was: what source
// held for the distributor on the account, of what f split from it (at most
// all of it).
func svdShare(source, f *ledger.Transaction) decimal.Decimal {
	var paid decimal.Decimal
	var holder, account string
	for _, l := range f.SavingsLines {
		if l.Amount.IsNegative() {
			paid, holder, account = l.Amount.Neg(), l.HolderID, l.AccountID
		}
	}
	var gave decimal.Decimal
	for _, l := range source.SavingsLines {
		if l.HolderID == holder && l.AccountID == account && l.Amount.IsPositive() {
			gave = gave.Add(l.Amount)
		}
	}
	if !paid.IsPositive() {
		return decimal.Zero
	}
	return decimal.Min(gave.Div(paid), decimal.NewFromInt(1))
}

// liveHeld is what the holder holds on the account now, or 0 when it's
// deleted (its held money was released with it).
func (s *Service) liveHeld(ctx context.Context, tx pgx.Tx, userID, holderID, accountID string) (decimal.Decimal, error) {
	h, err := sqlc.New(tx).GetSavingsHolderForUpdate(ctx, sqlc.GetSavingsHolderForUpdateParams{ID: holderID, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && h.Deleted) {
		return decimal.Zero, nil
	}
	if err != nil {
		return decimal.Zero, err
	}
	return s.heldNow(ctx, tx, holderID, accountID)
}
