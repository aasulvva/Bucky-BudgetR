package schedules

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// ErrResolved means the occurrence isn't queued: it has been approved or
// skipped already.
var ErrResolved = errors.New("already resolved")

// Upcoming is a time a schedule comes due.
type Upcoming struct {
	ScheduleID string
	At         time.Time
}

// GetOccurrence returns one of the user's occurrences.
func (s *Service) GetOccurrence(ctx context.Context, userID, id string) (Occurrence, error) {
	r, err := sqlc.New(s.pool).GetOccurrence(ctx, sqlc.GetOccurrenceParams{ID: id, UserID: userID})
	if err != nil {
		return Occurrence{}, occurrenceNotFound(err, id)
	}
	return s.fromOccurrence(r), nil
}

// Approve records a queued occurrence and marks it applied. Without
// override, it records the schedule's transaction, dated at its scheduled
// time if the active cycle holds it, else now. With override, it records
// that instead (the user's edits). If it can't be recorded, nothing changes
// and the error says why.
func (s *Service) Approve(ctx context.Context, userID, id string, override *transactions.New) (Occurrence, transactions.Transaction, error) {
	if s.txs == nil {
		return Occurrence{}, transactions.Transaction{}, errors.New("no transactions service")
	}
	var out Occurrence
	var recorded transactions.Transaction
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		o, err := s.queued(ctx, q, userID, id)
		if err != nil {
			return err
		}
		var n transactions.New
		if override != nil {
			n = *override
			if n.At.IsZero() {
				n.At = s.now()
			}
			if n.At.After(s.now()) {
				return fmt.Errorf("%w: the transaction time is in the future", ErrInvalid)
			}
		} else {
			sch, err := get(ctx, q, userID, o.ScheduleID)
			if err != nil {
				return err
			}
			n = sch.Transaction
			n.At = s.now()
			c, err := q.GetActiveCycle(ctx, userID)
			switch {
			case err == nil:
				if !o.ScheduledAt.Before(c.StartAt) && o.ScheduledAt.Before(c.EndAt) {
					n.At = o.ScheduledAt
				}
			case !errors.Is(err, pgx.ErrNoRows):
				return err
			}
		}
		if recorded, err = s.txs.RecordIn(ctx, tx, userID, n); err != nil {
			return err
		}
		r, err := q.ResolveOccurrence(ctx, sqlc.ResolveOccurrenceParams{
			State: sqlc.OccurrenceStateApplied, TransactionID: pgtype.Text{String: recorded.ID, Valid: true},
			ResolvedAt: pgtype.Timestamptz{Time: s.now(), Valid: true}, ID: id, UserID: userID,
		})
		if err != nil {
			return err
		}
		out = s.fromOccurrence(r)
		return nil
	})
	if err != nil {
		return Occurrence{}, transactions.Transaction{}, err
	}
	// Read back, so it's as Get returns it (with its schedule).
	if t, err := s.txs.Get(ctx, userID, recorded.ID); err == nil {
		recorded = t
	}
	return out, recorded, nil
}

// Skip marks a queued occurrence skipped: it's never recorded.
func (s *Service) Skip(ctx context.Context, userID, id string) (Occurrence, error) {
	var out Occurrence
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		if _, err := s.queued(ctx, q, userID, id); err != nil {
			return err
		}
		r, err := q.ResolveOccurrence(ctx, sqlc.ResolveOccurrenceParams{
			State: sqlc.OccurrenceStateSkipped, ResolvedAt: pgtype.Timestamptz{Time: s.now(), Valid: true},
			ID: id, UserID: userID,
		})
		if err != nil {
			return err
		}
		out = s.fromOccurrence(r)
		return nil
	})
	return out, err
}

// queued locks a queued occurrence.
func (s *Service) queued(ctx context.Context, q *sqlc.Queries, userID, id string) (Occurrence, error) {
	r, err := q.GetOccurrenceForUpdate(ctx, sqlc.GetOccurrenceForUpdateParams{ID: id, UserID: userID})
	if err != nil {
		return Occurrence{}, occurrenceNotFound(err, id)
	}
	if r.State != sqlc.OccurrenceStateQueued {
		return Occurrence{}, fmt.Errorf("%w: it was %s", ErrResolved, r.State)
	}
	return s.fromOccurrence(r), nil
}

// UpcomingAll returns the next n times any of the user's schedules comes
// due, earliest first. Paused and ended schedules are left out.
func (s *Service) UpcomingAll(ctx context.Context, userID string, n int) ([]Upcoming, error) {
	if n < 1 || n > MaxUpcoming {
		return nil, fmt.Errorf("%w: the count must be 1 to %d", ErrInvalid, MaxUpcoming)
	}
	list, err := s.List(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := []Upcoming{}
	for _, sch := range list {
		if sch.Paused || sch.NextAt.IsZero() {
			continue
		}
		rule, err := sch.Rule()
		if err != nil {
			continue
		}
		for _, at := range rule.Upcoming(sch.NextAt, n) {
			out = append(out, Upcoming{ScheduleID: sch.ID, At: at})
		}
	}
	slices.SortStableFunc(out, func(a, b Upcoming) int { return a.At.Compare(b.At) })
	return out[:min(n, len(out))], nil
}

func occurrenceNotFound(err error, id string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: scheduled transaction %s", ErrNotFound, id)
	}
	return err
}
