package cards

// A credit card's bill (#262, spec §2.2). On each statement day S the card
// owes what it owed at the cutoff, S's start in the user's time zone, and the
// bill is due on the first due day after S. The current statement (the
// latest S up to today) is worked out from the transactions, so ones entered
// late but dated before the cutoff still count, until it's fixed: checked
// against the bank's statement, or once its due date has passed. Fixed
// statements are stored and don't change.

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/calendar"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
)

// Bill errors.
var (
	// ErrNotCard means the account isn't a credit card.
	ErrNotCard = errors.New("the account isn't a credit card")
	// ErrNotFound means the user has no such live account.
	ErrNotFound = errors.New("account not found")
	// ErrBillSetUp means the card's bill was set up already.
	ErrBillSetUp = errors.New("the card's bill is set up already")
	// ErrBillNotSetUp means the card's bill must be set up first.
	ErrBillNotSetUp = errors.New("the card's bill isn't set up yet")
	// ErrNoStatement means the card has no statement yet.
	ErrNoStatement = errors.New("the card has no statement yet")
	// ErrStatementFixed means the statement was fixed already.
	ErrStatementFixed = errors.New("the statement is fixed already")
)

// Who fixed a statement.
const (
	FixedByBank  = sqlc.CardStatementFixBank
	FixedByDue   = sqlc.CardStatementFixDue
	FixedBySetup = sqlc.CardStatementFixSetup
	FixedByAuto  = sqlc.CardStatementFixAuto
)

// Statement is one of a card's statements, fixed or worked out.
type Statement struct {
	ID string
	// Date is the statement day; Cutoff its start, which it covers everything
	// before; Due the day it's due.
	Date   calendar.Date
	Cutoff time.Time
	Due    calendar.Date
	// Amount is what the card owed at the cutoff (0 when in credit), and
	// Minimum the minimum payment on it: the card's, or Amount when less.
	Amount, Minimum decimal.Decimal
	// Paid is what's been paid on it: transfers into the card from the cutoff
	// (to the next statement's, for an earlier one), and what the setup said
	// was paid before. Left and MinimumLeft are what's still to pay.
	Paid, Left, MinimumLeft decimal.Decimal
	// Fixed is set for a stored statement, with who fixed it and when.
	Fixed   bool
	FixedBy sqlc.CardStatementFix
	FixedAt time.Time
}

// Bill is a card's bill: whether it's set up, the current statement (nil
// before the first), the one before it if it was fixed, and the next
// statement day.
type Bill struct {
	SetUp    bool
	Current  *Statement
	Previous *Statement
	Next     calendar.Date
	// Payment is the current statement's scheduled payment, the newest, if
	// any (#262).
	Payment *Payment
}

// Payment is a scheduled bill payment: the schedule, its rule, what it pays
// now (or paid), from where, when, how, and where it's got to: "scheduled",
// or its occurrence's state ("queued", "applied", "skipped").
type Payment struct {
	ScheduleID string
	Rule       sqlc.CardPayRule
	Amount     decimal.Decimal
	AccountID  string
	At         time.Time
	Mode       sqlc.ScheduleMode
	State      string
	// Reason is a skipped one's: "paid" when nothing was left.
	Reason string
}

// dayIn returns day of the month, LastDay being its last day.
func dayIn(year int, month time.Month, day int) calendar.Date {
	if day == LastDay {
		return calendar.DateOf(time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC))
	}
	return calendar.Date{Year: year, Month: month, Day: day}
}

// monthAfter returns (year, month) one month after d's.
func monthAfter(d calendar.Date, n int) (int, time.Month) {
	t := time.Date(d.Year, d.Month+time.Month(n), 1, 0, 0, 0, 0, time.UTC)
	return t.Year(), t.Month()
}

// StatementDate returns the latest statement day up to today.
func StatementDate(statementDay int, today calendar.Date) calendar.Date {
	s := dayIn(today.Year, today.Month, statementDay)
	if today.Before(s) {
		y, m := monthAfter(today, -1)
		s = dayIn(y, m, statementDay)
	}
	return s
}

// NextStatementDate returns the statement day after s.
func NextStatementDate(statementDay int, s calendar.Date) calendar.Date {
	y, m := monthAfter(s, 1)
	return dayIn(y, m, statementDay)
}

// PreviousStatementDate returns the statement day before s.
func PreviousStatementDate(statementDay int, s calendar.Date) calendar.Date {
	y, m := monthAfter(s, -1)
	return dayIn(y, m, statementDay)
}

// DueDate returns the first due day after the statement day s.
func DueDate(s calendar.Date, dueDay int) calendar.Date {
	d := dayIn(s.Year, s.Month, dueDay)
	if !s.Before(d) {
		y, m := monthAfter(s, 1)
		d = dayIn(y, m, dueDay)
	}
	return d
}

// Location returns the user's time zone, UTC without one.
func Location(ctx context.Context, q *sqlc.Queries, userID string) (*time.Location, error) {
	row, err := q.CycleRuleOf(ctx, userID)
	if err != nil {
		return nil, err
	}
	if row.TimeZone == "" {
		return time.UTC, nil
	}
	loc, err := time.LoadLocation(row.TimeZone)
	if err != nil {
		return nil, fmt.Errorf("time zone: %w", err)
	}
	return loc, nil
}

// dateTime is a date as the database's date columns hold it.
func dateTime(d calendar.Date) time.Time { return d.Time(time.UTC) }

// dateOf is a date column's date.
func dateOf(t time.Time) calendar.Date { return calendar.DateOf(t.UTC()) }

// BillOf works out card's bill at now, reading only. A card that isn't one
// returns false.
func BillOf(ctx context.Context, q *sqlc.Queries, card sqlc.BankAccount, loc *time.Location, now time.Time) (Bill, bool, error) {
	f, ok := FieldsOf(card)
	if !ok {
		return Bill{}, false, nil
	}
	today := calendar.DateOf(now.In(loc))
	s := StatementDate(f.StatementDay, today)
	bill := Bill{SetUp: card.CardBillSetUpAt.Valid, Next: NextStatementDate(f.StatementDay, s)}
	if !bill.SetUp {
		return bill, true, nil
	}
	stored, err := q.CardStatementsFor(ctx, sqlc.CardStatementsForParams{CardID: card.ID, N: 2})
	if err != nil {
		return Bill{}, false, err
	}
	cur, err := statementOn(ctx, q, card, f, loc, s, stored)
	if err != nil {
		return Bill{}, false, err
	}
	bill.Current = cur
	if cur != nil && cur.Fixed {
		if bill.Payment, err = paymentFor(ctx, q, *cur); err != nil {
			return Bill{}, false, err
		}
	}
	if cur != nil {
		prev := PreviousStatementDate(f.StatementDay, s)
		for _, r := range stored {
			if dateOf(r.StatementDate) == prev {
				p, err := fromRow(ctx, q, r, &cur.Cutoff)
				if err != nil {
					return Bill{}, false, err
				}
				bill.Previous = &p
			}
		}
	}
	return bill, true, nil
}

// paymentFor returns the statement's newest scheduled payment, nil without.
func paymentFor(ctx context.Context, q *sqlc.Queries, st Statement) (*Payment, error) {
	rows, err := q.StatementSchedules(ctx, pgtype.Text{String: st.ID, Valid: true})
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	r := rows[0]
	p := &Payment{
		ScheduleID: r.ID, Rule: r.BillRule.CardPayRule, AccountID: r.AccountID, At: r.PayAt, Mode: r.Mode,
		State: r.OccurrenceState, Reason: r.OccurrenceReason,
		Amount: PayAmount(st, r.BillRule.CardPayRule, r.Amount),
	}
	if p.State == "" {
		p.State = "scheduled"
	}
	if p.State != "queued" && p.State != "scheduled" {
		p.Amount = r.Amount // what it was made with; paid or skipped
	}
	return p, nil
}

// statementOn returns the statement on day s: the stored one, or worked out
// when its cutoff comes after the bill was set up (before that, only the
// setup's statement counts); nil without one.
func statementOn(ctx context.Context, q *sqlc.Queries, card sqlc.BankAccount, f Fields, loc *time.Location,
	s calendar.Date, stored []sqlc.CardStatement) (*Statement, error) {
	for _, r := range stored {
		if dateOf(r.StatementDate) == s {
			st, err := fromRow(ctx, q, r, nil)
			return &st, err
		}
	}
	cutoff := s.Time(loc)
	if cutoff.Before(card.CardBillSetUpAt.Time) {
		return nil, nil
	}
	st, err := workOut(ctx, q, card.ID, f, s, cutoff)
	return &st, err
}

// workOut works a statement out from the transactions.
func workOut(ctx context.Context, q *sqlc.Queries, cardID string, f Fields, s calendar.Date, cutoff time.Time) (Statement, error) {
	bal, err := q.AccountBalanceBefore(ctx, sqlc.AccountBalanceBeforeParams{AccountID: cardID, Before: cutoff})
	if err != nil {
		return Statement{}, err
	}
	amount := decimal.Max(bal.Neg(), decimal.Zero)
	st := Statement{
		ID:   ids.CardStatementID(cardID, s.Year, s.Month, s.Day),
		Date: s, Cutoff: cutoff, Due: DueDate(s, f.DueDay),
		Amount: amount, Minimum: decimal.Min(f.MinimumPayment, amount),
	}
	return st, paid(ctx, q, cardID, &st, decimal.Zero, nil)
}

// fromRow is a stored statement, with what's been paid on it since its
// cutoff (until next, when given).
func fromRow(ctx context.Context, q *sqlc.Queries, r sqlc.CardStatement, next *time.Time) (Statement, error) {
	st := Statement{
		ID: r.ID, Date: dateOf(r.StatementDate), Cutoff: r.Cutoff, Due: dateOf(r.DueDate),
		Amount: r.Amount, Minimum: r.Minimum,
		Fixed: true, FixedBy: r.FixedBy, FixedAt: r.FixedAt,
	}
	return st, paid(ctx, q, r.CardID, &st, r.PaidBefore, next)
}

// StatementByID returns a fixed statement with everything paid on it since
// its cutoff (#262: what a scheduled bill payment pays).
func StatementByID(ctx context.Context, q *sqlc.Queries, id string) (Statement, error) {
	r, err := q.GetCardStatement(ctx, id)
	if err != nil {
		return Statement{}, err
	}
	return fromRow(ctx, q, r, nil)
}

// PayAmount is what a bill payment by rule pays on st now: what's left, the
// minimum left, or fixed, at most what's left.
func PayAmount(st Statement, rule sqlc.CardPayRule, fixed decimal.Decimal) decimal.Decimal {
	switch rule {
	case PayMinimum:
		return st.MinimumLeft
	case PayFixed:
		return decimal.Min(fixed, st.Left)
	}
	return st.Left
}

// paid fills in Paid, Left and MinimumLeft.
func paid(ctx context.Context, q *sqlc.Queries, cardID string, st *Statement, before decimal.Decimal, next *time.Time) error {
	to := pgtype.Timestamptz{}
	if next != nil {
		to = pgtype.Timestamptz{Time: *next, Valid: true}
	}
	p, err := q.CardPaymentsBetween(ctx, sqlc.CardPaymentsBetweenParams{CardID: cardID, FromAt: st.Cutoff, ToAt: to})
	if err != nil {
		return err
	}
	st.Paid = p.Add(before)
	st.Left = decimal.Max(st.Amount.Sub(st.Paid), decimal.Zero)
	st.MinimumLeft = decimal.Max(st.Minimum.Sub(st.Paid), decimal.Zero)
	return nil
}

// card returns the user's live credit card, locked for update.
func card(ctx context.Context, q *sqlc.Queries, userID, id string) (sqlc.BankAccount, error) {
	row, err := q.GetAccountForUpdate(ctx, sqlc.GetAccountForUpdateParams{ID: id, UserID: userID})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return sqlc.BankAccount{}, ErrNotFound
	case err == nil && row.AccountType != sqlc.AccountTypeCreditCard:
		return sqlc.BankAccount{}, ErrNotCard
	}
	return row, err
}

// LastStatement is what the bill's setup says about the card's last
// statement: its amount and what's been paid on it since.
type LastStatement struct {
	Amount, Paid decimal.Decimal
}

func (l LastStatement) check() error {
	for _, a := range []decimal.Decimal{l.Amount, l.Paid} {
		if err := money.Valid(a); err != nil {
			return fmt.Errorf("%w: %w", ErrInvalid, err)
		}
		if a.IsNegative() {
			return fmt.Errorf("%w: the last statement's amount and what's paid on it can't be below 0", ErrInvalid)
		}
	}
	return nil
}

// SetUp sets the card's bill up (#262): with the last statement, it's stored
// for the latest statement day as the setup's; without, the first statement
// is the next one. The caller holds the user's lock (in db's transaction).
// A card whose bill is set up returns ErrBillSetUp.
func SetUp(ctx context.Context, db sqlc.DBTX, userID, cardID string, last *LastStatement, now time.Time) error {
	q := sqlc.New(db)
	row, err := card(ctx, q, userID, cardID)
	if err != nil {
		return err
	}
	if row.CardBillSetUpAt.Valid {
		return ErrBillSetUp
	}
	if last != nil {
		if err := last.check(); err != nil {
			return err
		}
	}
	if _, err := q.SetCardBillSetUp(ctx, sqlc.SetCardBillSetUpParams{ID: cardID, UserID: userID, At: pgtype.Timestamptz{Time: now, Valid: true}}); err != nil {
		return err
	}
	if last == nil {
		return nil
	}
	return storeLast(ctx, q, userID, row, *last, now)
}

// SetUpNew stores a card's last statement as it's created; its bill is set
// up already (CreateAccount).
func SetUpNew(ctx context.Context, db sqlc.DBTX, userID string, row sqlc.BankAccount, last LastStatement, now time.Time) error {
	if err := last.check(); err != nil {
		return err
	}
	return storeLast(ctx, sqlc.New(db), userID, row, last, now)
}

func storeLast(ctx context.Context, q *sqlc.Queries, userID string, row sqlc.BankAccount, last LastStatement, now time.Time) error {
	f, _ := FieldsOf(row)
	loc, err := Location(ctx, q, userID)
	if err != nil {
		return err
	}
	s := StatementDate(f.StatementDay, calendar.DateOf(now.In(loc)))
	return store(ctx, q, userID, row.ID, Statement{
		Date: s, Cutoff: s.Time(loc), Due: DueDate(s, f.DueDay),
		Amount: last.Amount, Minimum: decimal.Min(f.MinimumPayment, last.Amount),
	}, last.Paid, FixedBySetup, now)
}

// store stores a statement, fixed by by at now (the app's clock, so a
// moved debug clock shows too).
func store(ctx context.Context, q *sqlc.Queries, userID, cardID string, st Statement,
	paidBefore decimal.Decimal, by sqlc.CardStatementFix, now time.Time) error {
	_, err := q.CreateCardStatement(ctx, sqlc.CreateCardStatementParams{
		ID: ids.CardStatementID(cardID, st.Date.Year, st.Date.Month, st.Date.Day), CardID: cardID,
		StatementDate: dateTime(st.Date), Cutoff: st.Cutoff, DueDate: dateTime(st.Due),
		Amount: st.Amount, Minimum: st.Minimum, PaidBefore: paidBefore, FixedBy: by,
		CreatedBy: pgtype.Text{String: userID, Valid: by != FixedByDue},
		FixedAt:   now,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // fixed meanwhile
	}
	return err
}

// Current returns the card's current statement as worked out or stored, for
// fixing it; the caller holds the user's lock.
func Current(ctx context.Context, db sqlc.DBTX, userID, cardID string, now time.Time) (*Statement, error) {
	q := sqlc.New(db)
	row, err := card(ctx, q, userID, cardID)
	if err != nil {
		return nil, err
	}
	if !row.CardBillSetUpAt.Valid {
		return nil, ErrBillNotSetUp
	}
	loc, err := Location(ctx, q, userID)
	if err != nil {
		return nil, err
	}
	bill, _, err := BillOf(ctx, q, row, loc, now)
	if err != nil {
		return nil, err
	}
	return bill.Current, nil
}

// Fix stores the card's current statement as worked out now, fixed by by
// (the bank's statement, after it's been adjusted to it). The caller holds
// the user's lock.
func Fix(ctx context.Context, db sqlc.DBTX, userID, cardID string, by sqlc.CardStatementFix, now time.Time) error {
	cur, err := Current(ctx, db, userID, cardID, now)
	if err != nil {
		return err
	}
	switch {
	case cur == nil:
		return ErrNoStatement
	case cur.Fixed:
		return ErrStatementFixed
	}
	return store(ctx, sqlc.New(db), userID, cardID, *cur, decimal.Zero, by, now)
}

// FixDue stores the statements whose due date has passed and aren't stored
// yet, the current and the one before, for the card. The caller holds the
// user's lock.
func FixDue(ctx context.Context, db sqlc.DBTX, row sqlc.BankAccount, now time.Time) error {
	f, ok := FieldsOf(row)
	if !ok || !row.CardBillSetUpAt.Valid {
		return nil
	}
	q := sqlc.New(db)
	loc, err := Location(ctx, q, row.UserID)
	if err != nil {
		return err
	}
	today := calendar.DateOf(now.In(loc))
	stored, err := q.CardStatementsFor(ctx, sqlc.CardStatementsForParams{CardID: row.ID, N: 2})
	if err != nil {
		return err
	}
	cur := StatementDate(f.StatementDay, today)
	for _, s := range []calendar.Date{PreviousStatementDate(f.StatementDay, cur), cur} {
		if !DueDate(s, f.DueDay).Before(today) {
			continue
		}
		st, err := statementOn(ctx, q, row, f, loc, s, stored)
		if err != nil || st == nil || st.Fixed {
			if err != nil {
				return err
			}
			continue
		}
		if err := store(ctx, q, row.UserID, row.ID, *st, decimal.Zero, FixedByDue, now); err != nil {
			return err
		}
	}
	return nil
}
