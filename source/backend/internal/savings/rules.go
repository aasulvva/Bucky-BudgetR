package savings

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
)

// The distributor's rules (#232, spec §8): per target, ranges of its position
// with a priority each.

const (
	// MaxRules is how many rules one target can have.
	MaxRules = 20
	// MaxPriority is a rule's highest priority; 0 gives the target nothing.
	MaxPriority = 6
)

var (
	// ErrRuleOverlap is a rule whose range overlaps another of its target's.
	ErrRuleOverlap = errors.New("the range overlaps another rule of the target")
	// ErrTooManyRules is a rule above MaxRules for its target.
	ErrTooManyRules = errors.New("the target has as many rules as it can")
)

// SavingsRule is a distributor rule: where the target's position is From or
// more and below To (no end when not Valid), it takes shares by Priority.
type SavingsRule struct {
	ID       string
	TargetID string
	From     decimal.Decimal
	To       decimal.NullDecimal
	Priority int
	PastGoal bool
}

// RuleInput is a rule's range, priority and whether it goes past the goal.
type RuleInput struct {
	From     decimal.Decimal
	To       decimal.NullDecimal
	Priority int
	PastGoal bool
}

// ListRules returns the rules of the user's live targets, by target and
// range.
func (s *Service) ListRules(ctx context.Context, userID string) ([]SavingsRule, error) {
	rows, err := sqlc.New(s.pool).ListSavingsRules(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make([]SavingsRule, len(rows))
	for i, r := range rows {
		out[i] = toRule(r)
	}
	return out, nil
}

// CreateRule adds a rule to a target.
func (s *Service) CreateRule(ctx context.Context, userID, targetID string, in RuleInput) (SavingsRule, error) {
	if err := checkRule(in); err != nil {
		return SavingsRule{}, err
	}
	var out SavingsRule
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		if _, err := lockTarget(ctx, tx, userID, targetID); err != nil {
			return err
		}
		siblings, err := rulesOf(ctx, tx, userID, targetID)
		if err != nil {
			return err
		}
		if len(siblings) >= MaxRules {
			return fmt.Errorf("%w (%d)", ErrTooManyRules, MaxRules)
		}
		if err := checkOverlap(in, siblings, ""); err != nil {
			return err
		}
		q := sqlc.New(tx)
		var row sqlc.SavingsRule
		_, err = ids.Insert(ctx, ids.SavingsRule, func() string { return ids.NewSavingsRule(targetID) },
			func(ctx context.Context, id string) (bool, error) {
				var err error
				row, err = q.CreateSavingsRule(ctx, sqlc.CreateSavingsRuleParams{
					ID: id, TargetID: targetID, UserID: userID,
					RangeFrom: in.From, RangeTo: in.To, Priority: int16(in.Priority), PastGoal: in.PastGoal, //nolint:gosec // checkRule: 0–6
				})
				return ids.Inserted(err)
			})
		out = toRule(row)
		return err
	})
	if err != nil {
		return SavingsRule{}, err
	}
	return out, nil
}

// UpdateRule changes a rule's range, priority and past-the-goal. Its target
// stays.
func (s *Service) UpdateRule(ctx context.Context, userID, id string, in RuleInput) (SavingsRule, error) {
	if err := checkRule(in); err != nil {
		return SavingsRule{}, err
	}
	var out SavingsRule
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		cur, err := q.GetSavingsRule(ctx, sqlc.GetSavingsRuleParams{ID: id, UserID: userID})
		if err != nil {
			return notFound(err, "savings rule", id)
		}
		if _, err := lockTarget(ctx, tx, userID, cur.TargetID); err != nil {
			return err
		}
		siblings, err := rulesOf(ctx, tx, userID, cur.TargetID)
		if err != nil {
			return err
		}
		if err := checkOverlap(in, siblings, id); err != nil {
			return err
		}
		row, err := q.UpdateSavingsRule(ctx, sqlc.UpdateSavingsRuleParams{
			ID: id, UserID: userID, RangeFrom: in.From, RangeTo: in.To, Priority: int16(in.Priority), PastGoal: in.PastGoal, //nolint:gosec // checkRule: 0–6
		})
		out = toRule(row)
		return err
	})
	if err != nil {
		return SavingsRule{}, err
	}
	return out, nil
}

// DeleteRule deletes a rule.
func (s *Service) DeleteRule(ctx context.Context, userID, id string) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		n, err := sqlc.New(tx).DeleteSavingsRule(ctx, sqlc.DeleteSavingsRuleParams{ID: id, UserID: userID})
		if err != nil {
			return err
		}
		if n == 0 {
			return fmt.Errorf("%w: savings rule %s", ErrNotFound, id)
		}
		return nil
	})
}

func checkRule(in RuleInput) error {
	if err := money.Valid(in.From); err != nil {
		return fmt.Errorf("%w: from: %w", ErrInvalid, err)
	}
	if in.From.IsNegative() {
		return fmt.Errorf("%w: a range starts at 0 or more", ErrInvalid)
	}
	if in.To.Valid {
		if err := money.Valid(in.To.Decimal); err != nil {
			return fmt.Errorf("%w: to: %w", ErrInvalid, err)
		}
		if !in.To.Decimal.GreaterThan(in.From) {
			return fmt.Errorf("%w: a range ends above where it starts", ErrInvalid)
		}
	}
	if in.Priority < 0 || in.Priority > MaxPriority {
		return fmt.Errorf("%w: the priority is 0 to %d", ErrInvalid, MaxPriority)
	}
	return nil
}

// checkOverlap refuses a range that overlaps a sibling's, other than skip:
// ranges run from From up to, not including, To, so touching ones are fine.
func checkOverlap(in RuleInput, siblings []SavingsRule, skip string) error {
	for _, r := range siblings {
		if r.ID == skip {
			continue
		}
		startsBeforeItEnds := !r.To.Valid || in.From.LessThan(r.To.Decimal)
		endsAfterItStarts := !in.To.Valid || r.From.LessThan(in.To.Decimal)
		if startsBeforeItEnds && endsAfterItStarts {
			return fmt.Errorf("%w (%s)", ErrRuleOverlap, rangeText(r.From, r.To))
		}
	}
	return nil
}

func rangeText(from decimal.Decimal, to decimal.NullDecimal) string {
	if !to.Valid {
		return from.StringFixed(money.Places) + " and up"
	}
	return from.StringFixed(money.Places) + "–" + to.Decimal.StringFixed(money.Places)
}

func rulesOf(ctx context.Context, tx pgx.Tx, userID, targetID string) ([]SavingsRule, error) {
	rows, err := sqlc.New(tx).ListSavingsRules(ctx, userID)
	if err != nil {
		return nil, err
	}
	var out []SavingsRule
	for _, r := range rows {
		if r.TargetID == targetID {
			out = append(out, toRule(r))
		}
	}
	return out, nil
}

func toRule(r sqlc.SavingsRule) SavingsRule {
	return SavingsRule{
		ID: r.ID, TargetID: r.TargetID, From: r.RangeFrom, To: r.RangeTo,
		Priority: int(r.Priority), PastGoal: r.PastGoal,
	}
}

// ruleOf is a stored rule as Split uses it.
func ruleOf(r sqlc.SavingsRule) Rule {
	out := Rule{From: r.RangeFrom, Priority: int(r.Priority), PastGoal: r.PastGoal}
	if r.RangeTo.Valid {
		to := r.RangeTo.Decimal
		out.To = &to
	}
	return out
}
