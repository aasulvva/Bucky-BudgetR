package schedules

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/refill"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// MaxCatchUp is the most occurrences of one schedule a run handles. After a
// long downtime the rest follow on the next runs.
const MaxCatchUp = 100

// RunLoop runs the due occurrences now and then every interval until ctx is
// done.
func (s *Service) RunLoop(ctx context.Context, interval time.Duration, logger *slog.Logger) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if err := s.RunDue(ctx, logger); err != nil && ctx.Err() == nil {
			logger.WarnContext(ctx, "scheduled transactions failed", slog.Any("error", err))
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// RunDue handles every occurrence that is due: in order, each schedule's
// occurrences up to now, so after a downtime the missed ones follow. A user
// whose run fails is logged and tried again on the next run.
func (s *Service) RunDue(ctx context.Context, logger *slog.Logger) error {
	now := s.now()
	users, err := sqlc.New(s.pool).UsersWithDueSchedules(ctx, now)
	if err != nil {
		return err
	}
	for _, id := range users {
		if err := s.runUser(ctx, id, now); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			logger.WarnContext(ctx, "scheduled transactions failed", slog.String("user_id", id), slog.Any("error", err))
		}
	}
	return nil
}

// runUser handles one user's due occurrences in one database transaction,
// under the user's lock. Each occurrence is checked against the ones already
// handled, so a run that repeats (after a crash, or on a second server)
// handles nothing twice.
func (s *Service) runUser(ctx context.Context, userID string, now time.Time) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		rows, err := q.DueSchedulesForUpdate(ctx, sqlc.DueSchedulesForUpdateParams{UserID: userID, Now: now})
		if err != nil {
			return err
		}
		list, err := withLines(ctx, q, rows)
		if err != nil {
			return err
		}
		for _, sch := range list {
			if err := s.runSchedule(ctx, tx, userID, sch, now); err != nil {
				return fmt.Errorf("schedule %s: %w", sch.ID, err)
			}
		}
		return nil
	})
}

func (s *Service) runSchedule(ctx context.Context, tx pgx.Tx, userID string, sch Schedule, now time.Time) error {
	q := sqlc.New(tx)
	rule, err := sch.Rule()
	if err != nil {
		return err
	}
	k, at, ok := sch.NextIndex, sch.NextAt, true
	for range MaxCatchUp {
		if !ok || handleFrom(sch, at).After(now) {
			break
		}
		if err := s.handle(ctx, tx, userID, sch, at, now); err != nil {
			return err
		}
		k++
		at, ok = rule.Occurrence(k)
	}
	next := pgtype.Timestamptz{}
	if ok {
		next = pgtype.Timestamptz{Time: at.UTC(), Valid: true}
	}
	return q.AdvanceSchedule(ctx, sqlc.AdvanceScheduleParams{ID: sch.ID, NextIndex: int32(k), NextAt: next}) //nolint:gosec // at most maxIndex
}

// handle records or queues the occurrence at at, unless it has been handled.
func (s *Service) handle(ctx context.Context, tx pgx.Tx, userID string, sch Schedule, at, now time.Time) error {
	q := sqlc.New(tx)
	done, err := q.OccurrenceExists(ctx, sqlc.OccurrenceExistsParams{ScheduleID: sch.ID, ScheduledAt: at})
	if err != nil || done {
		return err
	}
	p := sqlc.CreateOccurrenceParams{ScheduleID: sch.ID, UserID: userID, ScheduledAt: at.UTC()}
	reason, detail := sqlc.OccurrenceReasonApproval, ""
	if sch.Mode == sqlc.ScheduleModeAuto {
		id, err := s.record(ctx, tx, userID, sch, at)
		if reason, detail = reasonOf(err); reason == "" && err != nil {
			return err
		}
		if err == nil {
			p.State = sqlc.OccurrenceStateApplied
			p.TransactionID = pgtype.Text{String: id, Valid: true}
			p.ResolvedAt = pgtype.Timestamptz{Time: now, Valid: true}
		}
	}
	if p.State == "" {
		p.State = sqlc.OccurrenceStateQueued
		p.Reason = sqlc.NullOccurrenceReason{OccurrenceReason: reason, Valid: true}
		p.Detail = detail
		p.QueuedAt = pgtype.Timestamptz{Time: now, Valid: true}
		// Due at its time: an approve one is queued DueDays before it.
		p.DueAt = pgtype.Timestamptz{Time: at.UTC(), Valid: true}
	}
	_, err = ids.Insert(ctx, ids.Occurrence, func() string { return ids.NewOccurrence(sch.ID) }, func(ctx context.Context, id string) (bool, error) {
		p.ID = id
		_, err := q.CreateOccurrence(ctx, p)
		return ids.Inserted(err)
	})
	return err
}

// record records the occurrence in a savepoint, so a failed one leaves
// nothing behind, and returns the transaction's ID.
func (s *Service) record(ctx context.Context, tx pgx.Tx, userID string, sch Schedule, at time.Time) (string, error) {
	if s.txs == nil {
		return "", errors.New("no transactions service")
	}
	n := sch.Transaction
	n.At = at
	var id string
	err := pgx.BeginFunc(ctx, tx, func(sp pgx.Tx) error {
		t, err := s.txs.RecordIn(ctx, sp, userID, n)
		id = t.ID
		return err
	})
	return id, err
}

// reasonOf is why an occurrence that failed with err is queued instead, and
// the error to show; "" for an error that isn't the occurrence's (the
// database's), which fails the run.
func reasonOf(err error) (sqlc.OccurrenceReason, string) {
	switch {
	case err == nil:
		return "", ""
	case errors.Is(err, ledger.ErrNoActiveCycle):
		return sqlc.OccurrenceReasonNoActiveCycle, ""
	case errors.Is(err, ledger.ErrOutsideCycle):
		return sqlc.OccurrenceReasonOutsideCycle, ""
	case errors.Is(err, transactions.ErrInvalid), errors.Is(err, transactions.ErrCurrencyMismatch),
		errors.Is(err, ledger.ErrInvalid), errors.Is(err, ledger.ErrNotFound), errors.Is(err, ledger.ErrUnsupported),
		errors.Is(err, refill.ErrUnavailable):
		return sqlc.OccurrenceReasonInvalid, err.Error()
	}
	return "", ""
}

// handleFrom is when the scheduler handles the occurrence at at: then for
// an auto schedule, and DueDays days (of 24 hours, as in the due queries)
// before for an approve schedule, which queues it so it can be approved
// early.
func handleFrom(sch Schedule, at time.Time) time.Time {
	if sch.Mode != sqlc.ScheduleModeApprove {
		return at
	}
	return at.Add(-time.Duration(sch.DueDays) * 24 * time.Hour)
}
