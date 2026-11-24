package accounts

// A credit card's bill (#262, spec §2.2): reading it, setting it up,
// checking it against the bank's statement, and fixing statements whose due
// date has passed. The rules are in package cards.

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cards"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
)

// Bill returns the card's bill, first fixing its statements whose due date
// has passed.
func (s *Service) Bill(ctx context.Context, userID, cardID string) (cards.Bill, error) {
	var out cards.Bill
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		row, err := q.GetAccount(ctx, sqlc.GetAccountParams{ID: cardID, UserID: userID})
		if err != nil {
			return notFound(err, cardID)
		}
		if err := cards.FixDue(ctx, tx, row, s.now()); err != nil {
			return err
		}
		out, err = billOf(ctx, q, row, s.now())
		return err
	})
	return out, err
}

// billOf is the card's bill as it stands, ErrNotCard for another account.
func billOf(ctx context.Context, q *sqlc.Queries, row sqlc.BankAccount, now time.Time) (cards.Bill, error) {
	loc, err := cards.Location(ctx, q, row.UserID)
	if err != nil {
		return cards.Bill{}, err
	}
	bill, ok, err := cards.BillOf(ctx, q, row, loc, now)
	if err == nil && !ok {
		err = cards.ErrNotCard
	}
	return bill, err
}

// SetUpBill sets a card's bill up, with its last statement or without one.
func (s *Service) SetUpBill(ctx context.Context, userID, cardID string, last *cards.LastStatement) (cards.Bill, error) {
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		return cards.SetUp(ctx, tx, userID, cardID, last, s.now())
	})
	if err != nil {
		return cards.Bill{}, err
	}
	return s.Bill(ctx, userID, cardID)
}

// ConfirmBill checks the card's current statement against the bank's
// amount. When they differ, a balance adjustment (BLA) dated just before
// the cutoff makes what the card owed then the bank's amount (a fee or
// purchase the app missed); then the statement is fixed.
func (s *Service) ConfirmBill(ctx context.Context, userID, cardID string, amount decimal.Decimal) (cards.Bill, error) {
	if err := money.Valid(amount); err != nil {
		return cards.Bill{}, fmt.Errorf("%w: amount: %w", ErrInvalid, err)
	}
	if amount.IsNegative() {
		return cards.Bill{}, fmt.Errorf("%w: the statement's amount can't be below 0", ErrInvalid)
	}
	var cur *cards.Statement
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		var err error
		cur, err = cards.Current(ctx, tx, userID, cardID, s.now())
		return err
	})
	switch {
	case err != nil:
		return cards.Bill{}, err
	case cur == nil:
		return cards.Bill{}, cards.ErrNoStatement
	case cur.Fixed:
		return cards.Bill{}, cards.ErrStatementFixed
	}
	if !cur.Amount.Equal(amount) {
		if _, err := s.AdjustBalance(ctx, userID, cardID, Adjustment{
			Target: amount.Neg(), At: cur.Cutoff.Add(-time.Microsecond),
		}); err != nil {
			return cards.Bill{}, err
		}
	}
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		return cards.Fix(ctx, tx, userID, cardID, cards.FixedByBank, s.now())
	})
	if err != nil {
		return cards.Bill{}, err
	}
	return s.Bill(ctx, userID, cardID)
}

// FixBillsLoop fixes every card's statements whose due date has passed,
// every interval, until ctx is done.
func (s *Service) FixBillsLoop(ctx context.Context, interval time.Duration, logger *slog.Logger) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if err := s.FixDueBills(ctx); err != nil && ctx.Err() == nil {
			logger.WarnContext(ctx, "fixing card statements failed", slog.Any("error", err))
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// FixDueBills fixes every card's statements whose due date has passed.
func (s *Service) FixDueBills(ctx context.Context) error {
	rows, err := sqlc.New(s.pool).CardsWithBills(ctx)
	if err != nil {
		return err
	}
	for _, row := range rows {
		err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
			if err := ledger.LockUser(ctx, tx, row.UserID); err != nil {
				return err
			}
			return cards.FixDue(ctx, tx, row, s.now())
		})
		if err != nil {
			return err
		}
	}
	return nil
}
