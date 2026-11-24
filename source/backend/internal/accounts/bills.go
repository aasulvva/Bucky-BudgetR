package accounts

// A credit card's bill (#262, spec §2.2): reading it, setting it up,
// finalizing and paying it (by hand or auto-finalized), and fixing statements
// whose due date has passed. The rules are in package cards.

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/calendar"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cards"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/schedules"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
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

// Finalize is what finalizing a card's bill says (#262): the amount on the
// bank's statement, and the payment, if any.
type Finalize struct {
	Amount  decimal.Decimal
	Payment *Payment
}

// Payment is how a finalized bill is paid: by Rule (Amount for
// cards.PayFixed) from AccountID, at At (zero: now) recorded (auto) or asked
// first (approve). Paid now, it's recorded at once, asking first like a
// transaction (BSUConfirmed, LimitConfirmed); later, it's a one-off schedule
// that pays what the rule says when it runs.
type Payment struct {
	Rule                         sqlc.CardPayRule
	Amount                       decimal.Decimal
	AccountID                    string
	At                           time.Time
	Mode                         sqlc.ScheduleMode
	BSUConfirmed, LimitConfirmed bool
}

// Finalized is a finalized bill, with the payment's schedule or transaction
// (neither without one, or with nothing left to pay).
type Finalized struct {
	Bill          cards.Bill
	ScheduleID    string
	TransactionID string
}

// FinalizeBill finalizes the card's current statement: when the bank's
// amount differs, a balance adjustment (BLA) dated just before the cutoff
// makes what the card owed then the bank's amount (a fee or purchase the app
// missed); then the statement is fixed, and the payment recorded or
// scheduled. All in one database transaction.
func (s *Service) FinalizeBill(ctx context.Context, userID, cardID string, f Finalize) (Finalized, error) {
	var out Finalized
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		var err error
		out, err = s.finalizeIn(ctx, tx, userID, cardID, f, cards.FixedByBank)
		return err
	})
	if err != nil {
		return Finalized{}, err
	}
	out.Bill, err = s.Bill(ctx, userID, cardID)
	return out, err
}

func (s *Service) finalizeIn(ctx context.Context, tx pgx.Tx, userID, cardID string, f Finalize,
	by sqlc.CardStatementFix) (Finalized, error) {
	if err := money.Valid(f.Amount); err != nil {
		return Finalized{}, fmt.Errorf("%w: amount: %w", ErrInvalid, err)
	}
	if f.Amount.IsNegative() {
		return Finalized{}, fmt.Errorf("%w: the statement's amount can't be below 0", ErrInvalid)
	}
	if p := f.Payment; p != nil {
		if err := (cards.Pay{Rule: p.Rule, Amount: p.Amount, Mode: p.Mode}).Check(); err != nil {
			return Finalized{}, err
		}
	}
	cur, err := cards.Current(ctx, tx, userID, cardID, s.now())
	switch {
	case err != nil:
		return Finalized{}, err
	case cur == nil:
		return Finalized{}, cards.ErrNoStatement
	case cur.Fixed:
		return Finalized{}, cards.ErrStatementFixed
	}
	if !cur.Amount.Equal(f.Amount) {
		if err := s.adjustIn(ctx, tx, userID, cardID, Adjustment{
			Target: f.Amount.Neg(), At: cur.Cutoff.Add(-time.Microsecond),
		}); err != nil && !errors.Is(err, ErrNoChange) {
			return Finalized{}, err
		}
	}
	if err := cards.Fix(ctx, tx, userID, cardID, by, s.now()); err != nil {
		return Finalized{}, err
	}
	if f.Payment == nil {
		return Finalized{}, nil
	}
	if cur, err = cards.Current(ctx, tx, userID, cardID, s.now()); err != nil {
		return Finalized{}, err
	}
	return s.payBill(ctx, tx, userID, cardID, *cur, *f.Payment, by == cards.FixedByAuto)
}

// payBill records or schedules the payment of the fixed statement st.
// Automatic ones (auto-finalize) record without asking, as schedules do.
func (s *Service) payBill(ctx context.Context, tx pgx.Tx, userID, cardID string, st cards.Statement, p Payment,
	automatic bool) (Finalized, error) {
	if s.txs == nil || s.schedules == nil {
		return Finalized{}, errors.New("no transactions or schedules service")
	}
	q := sqlc.New(tx)
	from, err := q.GetAccount(ctx, sqlc.GetAccountParams{ID: p.AccountID, UserID: userID})
	if err != nil {
		return Finalized{}, notFound(err, p.AccountID)
	}
	card, err := q.GetAccount(ctx, sqlc.GetAccountParams{ID: cardID, UserID: userID})
	if err != nil {
		return Finalized{}, err
	}
	if from.AccountType == sqlc.AccountTypeCreditCard || from.Currency != card.Currency {
		return Finalized{}, fmt.Errorf("%w: the bill is paid from an account in the card's currency that isn't a card", ErrInvalid)
	}
	amount := cards.PayAmount(st, p.Rule, p.Amount)
	if !amount.IsPositive() {
		return Finalized{}, nil // nothing left to pay
	}
	n := transactions.New{
		Type: sqlc.TransactionTypeTRF, AccountID: p.AccountID, ToAccountID: cardID, Amount: amount,
		BSUConfirmed: p.BSUConfirmed || automatic, LimitConfirmed: p.LimitConfirmed || automatic,
	}
	now := s.now()
	if p.Mode == sqlc.ScheduleModeAuto && !p.At.After(now) {
		n.At = now
		t, err := s.txs.RecordIn(ctx, tx, userID, n)
		if err != nil {
			return Finalized{}, err
		}
		return Finalized{TransactionID: t.ID}, nil
	}
	loc, err := cards.Location(ctx, q, userID)
	if err != nil {
		return Finalized{}, err
	}
	at := p.At
	if at.Before(now) {
		at = now
	}
	at = at.In(loc).Truncate(time.Minute)
	// An ask-first one is queued at once, due at its time.
	dueDays := 0
	if p.Mode == sqlc.ScheduleModeApprove {
		dueDays = min(int(math.Ceil(at.Sub(now).Hours()/24)), schedules.MaxDueDays)
	}
	sch, err := s.schedules.CreateBillPayment(ctx, tx, userID, schedules.Settings{
		Transaction: n, Mode: p.Mode, DueDays: max(dueDays, 0),
		Start:  time.Date(at.Year(), at.Month(), at.Day(), 0, 0, 0, 0, time.UTC),
		Minute: at.Hour()*60 + at.Minute(), TimeZone: loc.String(), Frequency: sqlc.ScheduleFrequencyOnce,
		Bill: &schedules.Bill{StatementID: st.ID, Rule: p.Rule, Amount: amount},
	})
	if err != nil {
		return Finalized{}, err
	}
	return Finalized{ScheduleID: sch.ID}, nil
}

// BillsLoop runs RunBills every interval, until ctx is done.
func (s *Service) BillsLoop(ctx context.Context, interval time.Duration, logger *slog.Logger) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if err := s.RunBills(ctx, logger); err != nil && ctx.Err() == nil {
			logger.WarnContext(ctx, "fixing card statements failed", slog.Any("error", err))
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// RunBills finalizes the bills of every card with auto-finalize on its
// payment day (#262), then fixes the statements whose due date has passed.
// An auto-finalize that fails is logged and left for the user.
func (s *Service) RunBills(ctx context.Context, logger *slog.Logger) error {
	rows, err := sqlc.New(s.pool).CardsWithBills(ctx)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if err := s.autoFinalize(ctx, row); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			logger.WarnContext(ctx, "auto-finalizing a card's bill failed",
				slog.String("account_id", row.ID), slog.Any("error", err))
		}
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

// autoFinalize finalizes the card's open current statement with its
// defaults once its payment day has come: the app's amount, paid from the
// default account.
func (s *Service) autoFinalize(ctx context.Context, row sqlc.BankAccount) error {
	f, _ := cards.FieldsOf(row)
	if f.Pay == nil || !f.Pay.AutoFinalize || f.DefaultAccountID == "" {
		return nil
	}
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, row.UserID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		loc, err := cards.Location(ctx, q, row.UserID)
		if err != nil {
			return err
		}
		cur, err := cards.Current(ctx, tx, row.UserID, row.ID, s.now())
		if err != nil || cur == nil || cur.Fixed {
			return err
		}
		payDay := cur.Due.AddDays(-f.Pay.DaysBefore)
		if calendar.DateOf(s.now().In(loc)).Before(payDay) {
			return nil
		}
		_, err = s.finalizeIn(ctx, tx, row.UserID, row.ID, Finalize{
			Amount: cur.Amount,
			Payment: &Payment{
				Rule: f.Pay.Rule, Amount: f.Pay.Amount, AccountID: f.DefaultAccountID, Mode: f.Pay.Mode,
				At: payDay.Time(loc).Add(PayHour * time.Hour),
			},
		}, cards.FixedByAuto)
		return err
	})
}

// PayHour is the hour of the payment day a scheduled bill payment is made
// at by default, in the user's time zone.
const PayHour = 8
