package savings

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
)

// Bucket overflow to savings (#233, spec §8.5): the refill routine asks for
// an overflow's savings lines, records them on its OVF, and then lets the
// savings move on (AfterOverflow). Undoing a refill only releases what's
// still held (ReleasableOverflow).

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
	if !funded.IsPositive() || b.OverflowDestination == sqlc.OverflowDestinationUnallocated {
		return nil, nil
	}
	account := b.SourceAccountID
	toTarget := decimal.Zero
	if b.OverflowDestination == sqlc.OverflowDestinationSavingsTarget {
		targets, err := list(ctx, tx, userID)
		if err != nil {
			return nil, err
		}
		i := slices.IndexFunc(targets, func(t Target) bool { return t.ID == b.OverflowTargetID.String })
		if i >= 0 {
			t := targets[i]
			if t.AccountID == account {
				return nil, nil
			}
			room, err := s.overflowRoom(ctx, tx, userID, t)
			if err != nil {
				return nil, err
			}
			toTarget = funded
			if room != nil && room.LessThan(toTarget) {
				toTarget = decimal.Max(*room, decimal.Zero)
			}
		}
	}
	var lines []ledger.SavingsLine
	if toTarget.IsPositive() {
		lines = append(lines, ledger.SavingsLine{HolderID: b.OverflowTargetID.String, AccountID: account, Amount: toTarget})
	}
	if rest := funded.Sub(toTarget); rest.IsPositive() {
		d, err := ensureDistributor(ctx, tx, userID)
		if err != nil {
			return nil, err
		}
		lines = append(lines, ledger.SavingsLine{HolderID: d.ID, AccountID: account, Amount: rest})
	}
	return lines, nil
}

// overflowRoom is how much more the target can take from overflow: up to its
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

// AfterOverflow moves an overflow's savings on, in its transaction: a bucket
// target funded from the account gets its share straight into the bucket
// (an SVB at the overflow's time, while a cycle holds it), and the
// distributor splits by its hold mode.
func (s *Service) AfterOverflow(ctx context.Context, tx pgx.Tx, userID, accountID string, at time.Time, lines []ledger.SavingsLine) error {
	q := sqlc.New(tx)
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
		if _, err := s.ledger.Record(ctx, tx, ledger.Entry{
			UserID: userID, Type: sqlc.TransactionTypeSVB, At: at,
			SavingsLines: []ledger.SavingsLine{{HolderID: h.ID, AccountID: accountID, Amount: l.Amount.Neg()}},
			BucketLines:  []ledger.BucketLine{{BucketID: b.ID, Amount: l.Amount}},
		}); err != nil {
			return err
		}
	}
	if distributor {
		_, err := s.Incoming(ctx, tx, userID, accountID)
		return err
	}
	return nil
}

// ReleasableOverflow is what reversing the overflow t can take off hold: each
// of its savings lines, but no more than its holder still holds on the
// account. What was distributed or moved on stays where it went.
func (s *Service) ReleasableOverflow(ctx context.Context, tx pgx.Tx, userID string, t *ledger.Transaction) ([]ledger.SavingsLine, error) {
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
