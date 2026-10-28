package cycles

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/calendar"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
)

// The cycle rule (#72) keeps the user's next cycles planned: each runs from
// one of the rule's dates to the next, in the user's time zone. The rule and
// the zone are preferences (cycle_rule, time_zone).
//
// The rule only appends cycles after the latest one, starting on one of its
// dates, so it never touches the user's own cycles. It tops up when a cycle
// starts or ends, hourly (PlanLoop), and when the rule changes (Replan).

// Rule is the cycle_rule preference.
type Rule struct {
	Day      int               `json:"day"`
	Shift    calendar.Shift    `json:"shift"`
	Holidays calendar.Holidays `json:"holidays"`
	// Ahead is how many planned cycles to keep.
	Ahead int `json:"ahead"`
}

// Calendar returns the rule's dates.
func (r Rule) Calendar() calendar.Rule {
	return calendar.Rule{Day: r.Day, Shift: r.Shift, Holidays: r.Holidays}
}

// Periods returns n of the rule's periods, from the one that contains from;
// without from, the one that contains today in the user's time zone (UTC
// when the user has none).
func (s *Service) Periods(ctx context.Context, userID string, r Rule, from *calendar.Date, n int) ([]calendar.Period, error) {
	if from == nil {
		row, err := sqlc.New(s.pool).CycleRuleOf(ctx, userID)
		if err != nil {
			return nil, err
		}
		loc := time.UTC
		if row.TimeZone != "" {
			if loc, err = time.LoadLocation(row.TimeZone); err != nil {
				return nil, fmt.Errorf("time zone: %w", err)
			}
		}
		today := calendar.DateOf(s.now().In(loc))
		from = &today
	}
	return r.Calendar().Periods(*from, n), nil
}

// TopUp plans cycles from the user's rule until Ahead are planned.
func (s *Service) TopUp(ctx context.Context, userID string) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		return s.topUp(ctx, tx, userID)
	})
}

// Replan replaces the planned cycles the rule made that nobody moved and that
// haven't begun with cycles from the user's current rule. Without a rule,
// they stay.
func (s *Service) Replan(ctx context.Context, userID string) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		rule, _, err := ruleOf(ctx, sqlc.New(tx), userID)
		if err != nil || rule == nil {
			return err
		}
		if err := sqlc.New(tx).DeleteUntouchedGenerated(ctx, sqlc.DeleteUntouchedGeneratedParams{UserID: userID, Now: s.now()}); err != nil {
			return err
		}
		return s.topUp(ctx, tx, userID)
	})
}

// PlanLoop tops up every user with a rule now and then every interval until
// ctx is done.
func (s *Service) PlanLoop(ctx context.Context, interval time.Duration, logger *slog.Logger) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if err := s.topUpAll(ctx, logger); err != nil && ctx.Err() == nil {
			logger.WarnContext(ctx, "cycle planning failed", slog.Any("error", err))
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (s *Service) topUpAll(ctx context.Context, logger *slog.Logger) error {
	users, err := sqlc.New(s.pool).UsersWithCycleRule(ctx)
	if err != nil {
		return err
	}
	for _, id := range users {
		if err := s.TopUp(ctx, id); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			logger.WarnContext(ctx, "cycle planning failed", slog.String("user_id", id), slog.Any("error", err))
		}
	}
	return nil
}

// topUp plans cycles from the user's rule until Ahead are planned. The first
// starts on the first of the rule's dates on or after both where the latest
// cycle ends and the start of today's period; each runs to the next date.
// The caller holds the user's lock.
func (s *Service) topUp(ctx context.Context, tx pgx.Tx, userID string) error {
	q := sqlc.New(tx)
	rule, loc, err := ruleOf(ctx, q, userID)
	if err != nil || rule == nil {
		return err
	}
	planned, err := q.CountFutureCycles(ctx, userID)
	if err != nil {
		return err
	}
	want := rule.Ahead - int(planned)
	if want <= 0 {
		return nil
	}
	last, err := q.LatestCycleEnd(ctx, userID)
	if err != nil {
		return err
	}

	cal := rule.Calendar()
	from := cal.Periods(calendar.DateOf(s.now().In(loc)), 1)[0].Start
	if d := calendar.DateOf(last.In(loc)); from.Before(d) {
		from = d
	}
	periods := cal.Periods(from, want+1)
	if periods[0].Start.Before(from) {
		periods = periods[1:]
	} else {
		periods = periods[:want]
	}

	// In a savepoint, so a conflict leaves the caller's transaction usable.
	sp, err := tx.Begin(ctx)
	if err != nil {
		return err
	}
	defer sp.Rollback(ctx) //nolint:errcheck // a no-op after Commit
	for _, p := range periods {
		// A cycle that ended early ends during the day; start there.
		start := latest(norm(p.Start.Time(loc)), last)
		end := norm(p.End.AddDays(1).Time(loc))
		_, err := ids.Insert(ctx, ids.Cycle, func() string { return ids.NewCycle(userID) }, func(ctx context.Context, id string) (bool, error) {
			_, err := sqlc.New(sp).CreateCycle(ctx, sqlc.CreateCycleParams{ID: id, UserID: userID, StartAt: start, EndAt: end, Generated: true})
			return ids.Inserted(err)
		})
		if errors.Is(constraint(err), ErrOverlap) {
			return nil // the user's cycles win
		}
		if err != nil {
			return err
		}
	}
	return sp.Commit(ctx)
}

// ruleOf returns the user's rule and time zone, or a nil rule when the user
// has no rule or no zone.
func ruleOf(ctx context.Context, q *sqlc.Queries, userID string) (*Rule, *time.Location, error) {
	row, err := q.CycleRuleOf(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	var rule *Rule
	if err := json.Unmarshal(row.Rule, &rule); err != nil {
		return nil, nil, fmt.Errorf("cycle rule: %w", err)
	}
	if rule == nil || row.TimeZone == "" {
		return nil, nil, nil
	}
	loc, err := time.LoadLocation(row.TimeZone)
	if err != nil {
		return nil, nil, fmt.Errorf("time zone: %w", err)
	}
	return rule, loc, nil
}
