// Package cycles manages budget cycles (spec §3): planning future cycles,
// starting one, extending the active cycle and ending it.
//
// Cycles end on their intended dates. Bucket lines after the active cycle's
// planned end are refused by the ledger until the user extends or ends it,
// and ending it late keeps the planned end. Ending early ends it now; the
// next planned cycle then starts now only if the user asks, otherwise there
// is a gap without an active cycle.
//
// Ending and starting run the OnEnd and OnStart hooks in the same database
// transaction. The cycle routines (OVF, REF; #19) plug in there.
package cycles

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
)

// Errors returned by the service. They may wrap a message saying more.
var (
	// ErrNotFound means the cycle doesn't exist or isn't the user's.
	ErrNotFound = errors.New("not found")
	// ErrInvalid means the request breaks a rule.
	ErrInvalid = errors.New("invalid")
	// ErrOverlap means the cycle would overlap another of the user's cycles.
	ErrOverlap = errors.New("the cycle overlaps another cycle")
	// ErrFinished means the cycle is finished, so it can't change.
	ErrFinished = errors.New("the cycle is finished")
	// ErrNotFuture means only a future (planned) cycle allows this.
	ErrNotFuture = errors.New("the cycle has already started")
	// ErrNotActive means only the active cycle can be ended.
	ErrNotActive = errors.New("the cycle isn't active")
	// ErrActiveExists means the user already has an active cycle.
	ErrActiveExists = errors.New("another cycle is active")
	// ErrNotNext means a later cycle was started while an earlier one is
	// still planned.
	ErrNotNext = errors.New("an earlier cycle is planned; start that one first")
)

// Hook runs inside the database transaction that ends or starts a cycle.
// An error rolls everything back.
type Hook func(ctx context.Context, tx pgx.Tx, c sqlc.Cycle) error

// Options configures a Service.
type Options struct {
	// Now returns the current time. Defaults to time.Now.
	Now func() time.Time
	// OnEnd runs before the active cycle is marked finished.
	OnEnd Hook
	// OnStart runs after a cycle has become active.
	OnStart Hook
}

// Service manages cycles.
type Service struct {
	pool *pgxpool.Pool
	opts Options
}

// NewService returns a Service.
func NewService(pool *pgxpool.Pool, opts Options) *Service {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Service{pool: pool, opts: opts}
}

// Current is the user's active cycle and the next planned one; either may be
// nil. With no active cycle, the UI prompts to start Next or create one.
type Current struct {
	Active *sqlc.Cycle
	Next   *sqlc.Cycle
}

// Changes are new start and end times; nil keeps a time as it is.
type Changes struct {
	StartAt *time.Time
	EndAt   *time.Time
}

// Ended is the result of ending a cycle: the finished cycle, and the cycle
// that started, if any.
type Ended struct {
	Ended   sqlc.Cycle
	Started *sqlc.Cycle
}

// List returns the user's cycles, oldest first.
func (s *Service) List(ctx context.Context, userID string) ([]sqlc.Cycle, error) {
	return sqlc.New(s.pool).ListCycles(ctx, userID)
}

// Get returns one of the user's cycles.
func (s *Service) Get(ctx context.Context, userID, id string) (sqlc.Cycle, error) {
	c, err := sqlc.New(s.pool).GetCycle(ctx, sqlc.GetCycleParams{ID: id, UserID: userID})
	if err != nil {
		return sqlc.Cycle{}, notFound(err, id)
	}
	return c, nil
}

// Current returns the user's active cycle and the next planned one.
func (s *Service) Current(ctx context.Context, userID string) (Current, error) {
	list, err := s.List(ctx, userID)
	if err != nil {
		return Current{}, err
	}
	var cur Current
	for i := range list {
		switch c := &list[i]; {
		case c.State == sqlc.CycleStateActive:
			cur.Active = c
		case c.State == sqlc.CycleStateFuture && cur.Next == nil: // oldest first
			cur.Next = c
		}
	}
	return cur, nil
}

// Create plans a future cycle from start up to (not including) end.
func (s *Service) Create(ctx context.Context, userID string, start, end time.Time) (sqlc.Cycle, error) {
	start, end = norm(start), norm(end)
	if err := s.checkFuture(start, end); err != nil {
		return sqlc.Cycle{}, err
	}
	var out sqlc.Cycle
	_, err := ids.Insert(ctx, ids.Cycle, func() string { return ids.NewCycle(userID) }, func(ctx context.Context, id string) (bool, error) {
		var err error
		out, err = sqlc.New(s.pool).CreateCycle(ctx, sqlc.CreateCycleParams{ID: id, UserID: userID, StartAt: start, EndAt: end})
		return ids.Inserted(err)
	})
	if err != nil {
		return sqlc.Cycle{}, constraint(err)
	}
	return out, nil
}

// Update moves a cycle's start or end. A future cycle may change both. The
// active cycle may only change its end, to after now and after its last
// bucket line; extending it pushes the next planned cycle's start along if
// they would overlap. Finished cycles can't change.
func (s *Service) Update(ctx context.Context, userID, id string, ch Changes) (sqlc.Cycle, error) {
	var out sqlc.Cycle
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		c, err := q.GetCycleForUpdate(ctx, sqlc.GetCycleForUpdateParams{ID: id, UserID: userID})
		if err != nil {
			return notFound(err, id)
		}
		start, end := c.StartAt, c.EndAt
		if ch.StartAt != nil {
			start = norm(*ch.StartAt)
		}
		if ch.EndAt != nil {
			end = norm(*ch.EndAt)
		}

		switch c.State {
		case sqlc.CycleStateFinished:
			return ErrFinished
		case sqlc.CycleStateFuture:
			if err := s.checkFuture(start, end); err != nil {
				return err
			}
			out, err = q.SetCycleTimes(ctx, sqlc.SetCycleTimesParams{ID: id, StartAt: start, EndAt: end})
			return constraint(err)
		}

		// Active.
		if !start.Equal(c.StartAt) {
			return fmt.Errorf("%w: the start of the active cycle can't change", ErrInvalid)
		}
		if !end.After(s.now()) {
			return fmt.Errorf("%w: the new end must be in the future", ErrInvalid)
		}
		last, err := q.LastBucketLineAt(ctx, id)
		if err != nil {
			return err
		}
		if !end.After(last) {
			return fmt.Errorf("%w: the cycle has bucket transactions after the new end", ErrInvalid)
		}
		if end.After(c.EndAt) {
			if err := pushNext(ctx, q, userID, end); err != nil {
				return err
			}
		}
		out, err = q.SetCycleTimes(ctx, sqlc.SetCycleTimesParams{ID: id, StartAt: start, EndAt: end})
		return constraint(err)
	})
	if err != nil {
		return sqlc.Cycle{}, err
	}
	return out, nil
}

// pushNext moves the next planned cycle's start to end if it starts earlier,
// so the active cycle can be extended to end.
func pushNext(ctx context.Context, q *sqlc.Queries, userID string, end time.Time) error {
	next, err := q.NextFutureCycle(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if !next.StartAt.Before(end) {
		return nil
	}
	if !end.Before(next.EndAt) {
		return fmt.Errorf("%w: the next cycle would have no time left", ErrOverlap)
	}
	_, err = q.SetCycleTimes(ctx, sqlc.SetCycleTimesParams{ID: next.ID, StartAt: end, EndAt: next.EndAt})
	return constraint(err)
}

// Delete deletes a future cycle.
func (s *Service) Delete(ctx context.Context, userID, id string) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		c, err := q.GetCycleForUpdate(ctx, sqlc.GetCycleForUpdateParams{ID: id, UserID: userID})
		if err != nil {
			return notFound(err, id)
		}
		if c.State != sqlc.CycleStateFuture {
			return ErrNotFuture
		}
		return q.DeleteCycle(ctx, sqlc.DeleteCycleParams{ID: id, UserID: userID})
	})
}

// Start starts the next planned cycle when the user has no active cycle. A
// cycle started before its planned start starts now; one whose start has
// passed keeps it.
func (s *Service) Start(ctx context.Context, userID, id string) (sqlc.Cycle, error) {
	var out sqlc.Cycle
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		c, err := q.GetCycleForUpdate(ctx, sqlc.GetCycleForUpdateParams{ID: id, UserID: userID})
		if err != nil {
			return notFound(err, id)
		}
		if c.State != sqlc.CycleStateFuture {
			return ErrNotFuture
		}
		if _, err := q.GetActiveCycleForUpdate(ctx, userID); err == nil {
			return ErrActiveExists
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		next, err := q.NextFutureCycle(ctx, userID)
		if err != nil {
			return err
		}
		if next.ID != id {
			return ErrNotNext
		}
		if now := s.now(); c.StartAt.After(now) {
			if c, err = q.SetCycleTimes(ctx, sqlc.SetCycleTimesParams{ID: id, StartAt: now, EndAt: c.EndAt}); err != nil {
				return constraint(err)
			}
		}
		out, err = s.activate(ctx, tx, q, c)
		return err
	})
	if err != nil {
		return sqlc.Cycle{}, err
	}
	return out, nil
}

// End ends the active cycle. Ended before its planned end, it ends now (or
// just after its last bucket line, if that is later); ended late, it keeps
// its planned end. The next planned cycle then starts if it begins where
// this one ended. If it begins later, it starts right away, from where this
// one ended, only with startNext; otherwise there is a gap.
func (s *Service) End(ctx context.Context, userID, id string, startNext bool) (Ended, error) {
	var out Ended
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		c, err := q.GetCycleForUpdate(ctx, sqlc.GetCycleForUpdateParams{ID: id, UserID: userID})
		if err != nil {
			return notFound(err, id)
		}
		if c.State != sqlc.CycleStateActive {
			return ErrNotActive
		}
		if s.opts.OnEnd != nil {
			if err := s.opts.OnEnd(ctx, tx, c); err != nil {
				return fmt.Errorf("cycle end routine: %w", err)
			}
		}

		if now := s.now(); now.Before(c.EndAt) {
			last, err := q.LastBucketLineAt(ctx, id)
			if err != nil {
				return err
			}
			end := latest(now, last.Add(time.Microsecond), c.StartAt.Add(time.Microsecond))
			if end.Before(c.EndAt) {
				if c, err = q.SetCycleTimes(ctx, sqlc.SetCycleTimesParams{ID: id, StartAt: c.StartAt, EndAt: end}); err != nil {
					return constraint(err)
				}
			}
		}
		if out.Ended, err = q.SetCycleState(ctx, sqlc.SetCycleStateParams{ID: id, State: sqlc.CycleStateFinished}); err != nil {
			return err
		}

		next, err := q.NextFutureCycle(ctx, userID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		switch {
		case !next.StartAt.After(c.EndAt):
		case startNext:
			if next, err = q.SetCycleTimes(ctx, sqlc.SetCycleTimesParams{ID: next.ID, StartAt: c.EndAt, EndAt: next.EndAt}); err != nil {
				return constraint(err)
			}
		default:
			return nil // a gap until the user starts it
		}
		started, err := s.activate(ctx, tx, q, next)
		if err != nil {
			return err
		}
		out.Started = &started
		return nil
	})
	if err != nil {
		return Ended{}, err
	}
	return out, nil
}

// activate makes c the active cycle and runs OnStart.
func (s *Service) activate(ctx context.Context, tx pgx.Tx, q *sqlc.Queries, c sqlc.Cycle) (sqlc.Cycle, error) {
	c, err := q.SetCycleState(ctx, sqlc.SetCycleStateParams{ID: c.ID, State: sqlc.CycleStateActive})
	if err != nil {
		return sqlc.Cycle{}, constraint(err)
	}
	if s.opts.OnStart != nil {
		if err := s.opts.OnStart(ctx, tx, c); err != nil {
			return sqlc.Cycle{}, fmt.Errorf("cycle start routine: %w", err)
		}
	}
	return c, nil
}

func (s *Service) now() time.Time { return norm(s.opts.Now()) }

// checkFuture checks the times of a planned cycle.
func (s *Service) checkFuture(start, end time.Time) error {
	if start.IsZero() || end.IsZero() {
		return fmt.Errorf("%w: a cycle needs a start and an end", ErrInvalid)
	}
	if !start.Before(end) {
		return fmt.Errorf("%w: the cycle must end after it starts", ErrInvalid)
	}
	if !end.After(s.now()) {
		return fmt.Errorf("%w: the cycle must end in the future", ErrInvalid)
	}
	return nil
}

// norm returns t as the database stores it: UTC, to the microsecond.
func norm(t time.Time) time.Time { return t.UTC().Truncate(time.Microsecond) }

func latest(ts ...time.Time) time.Time {
	return slices.MaxFunc(ts, func(a, b time.Time) int { return a.Compare(b) })
}

func notFound(err error, id string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: cycle %s", ErrNotFound, id)
	}
	return err
}

// constraint turns violations of the cycle constraints into service errors.
func constraint(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.ConstraintName {
		case "cycles_no_overlap":
			return ErrOverlap
		case "cycles_one_active":
			return ErrActiveExists
		}
	}
	return err
}
