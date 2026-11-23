package bsu

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/balance"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
)

// MinOpenedYear is the earliest year a BSU can say it was opened.
const MinOpenedYear = 1990

// YearHistory is what the app has recorded on a BSU in a year.
type YearHistory struct {
	Year     int
	Recorded Sums
}

// History is what the app knows of a BSU account, for its history setup:
// the user gives the real amounts per year, at least what's recorded.
type History struct {
	AccountID string
	// LatestOpenedYear is the latest year the account can have been opened:
	// the year of its first deposit, interest or withdrawal in the app, or
	// this year.
	LatestOpenedYear int
	// Years runs from LatestOpenedYear to this year.
	Years []YearHistory
	// Opening is what the opening balances (OPB) add up to, which the setup
	// brings to 0.
	Opening decimal.Decimal
	// Balance is the account's balance now.
	Balance decimal.Decimal
	// SetUpAt is when the history was set up; zero before.
	SetUpAt time.Time
	// Rules are the deposit limits, oldest first, for the form's warnings.
	Rules []Rule
}

// YearInput is the real amounts of a year, as the bank shows them.
type YearInput struct {
	Year int
	Sums
}

// SetUpInput is a BSU account's real history.
type SetUpInput struct {
	OpenedYear int
	// Years has one entry per year from OpenedYear to this year, in order.
	Years []YearInput
	// Balance is the balance now, at the bank.
	Balance decimal.Decimal
	// InterestCounterparty is the counterparty of the interest it records,
	// as Register interest gives it (#70); empty is the account's bank.
	InterestCounterparty string
}

// Description is what each transaction the setup records says.
func Description(year int) string { return fmt.Sprintf("BSU history %d", year) }

// History returns what the app knows of the user's BSU account id.
func (s *Service) History(ctx context.Context, userID, id string) (History, error) {
	q := sqlc.New(s.pool)
	a, err := q.GetAccount(ctx, sqlc.GetAccountParams{ID: id, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return History{}, fmt.Errorf("%w: account %s", ErrNotFound, id)
	}
	if err != nil {
		return History{}, err
	}
	if a.AccountType != sqlc.AccountTypeBsu {
		return History{}, ErrNotBSU
	}
	return s.history(ctx, s.pool, userID, a)
}

func (s *Service) history(ctx context.Context, db sqlc.DBTX, userID string, a sqlc.BankAccount) (History, error) {
	q := sqlc.New(db)
	sums, err := yearSums(ctx, q, userID, []string{a.ID})
	if err != nil {
		return History{}, err
	}
	now := s.now()
	this := Year(now)
	first := this
	for y := range sums[a.ID] {
		first = min(first, y)
	}
	out := History{AccountID: a.ID, LatestOpenedYear: first, Opening: decimal.Zero}
	for y := first; y <= this; y++ {
		r := sums[a.ID][y]
		out.Years = append(out.Years, YearHistory{Year: y, Recorded: Sums{
			Deposits: zeroed(r.Deposits), Interest: zeroed(r.Interest), Withdrawals: zeroed(r.Withdrawals),
		}})
	}
	opb, err := q.ListOpeningBalances(ctx, sqlc.ListOpeningBalancesParams{UserID: userID, AccountID: a.ID})
	if err != nil {
		return History{}, err
	}
	for _, o := range opb {
		out.Opening = out.Opening.Add(o.Net)
	}
	balances, err := balance.AccountsBefore(ctx, db, userID, now.Add(time.Microsecond))
	if err != nil {
		return History{}, err
	}
	out.Balance = balances[a.ID].Add(decimal.Zero)
	if a.BsuSetUpAt.Valid {
		out.SetUpAt = a.BsuSetUpAt.Time
	}
	if out.Rules, err = rules(ctx, q); err != nil {
		return History{}, err
	}
	return out, nil
}

// zeroed is d, or 0 for the zero value (so it prints as 0.00).
func zeroed(d decimal.Decimal) decimal.Decimal { return d.Add(decimal.Zero) }

// SetUp sets up the history of the user's BSU account id, once, in one
// database transaction: it brings the opening balance to 0, records what the
// app is missing of each year (a deposit, an interest income tagged interest
// and a withdrawal, each described as Description(year) and dated 31 Dec
// 12:00 Norwegian time, or now this year; the interest from
// in.InterestCounterparty, else the account's bank), and adjusts the balance (BLA) to
// in.Balance. The account is then no longer locked.
func (s *Service) SetUp(ctx context.Context, userID, id string, in SetUpInput) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		a, err := q.GetAccountForUpdate(ctx, sqlc.GetAccountForUpdateParams{ID: id, UserID: userID})
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("%w: account %s", ErrNotFound, id)
		}
		if err != nil {
			return err
		}
		if a.AccountType != sqlc.AccountTypeBsu || a.Currency != Currency {
			return ErrNotBSU
		}
		if a.BsuSetUpAt.Valid {
			return ErrSetUp
		}
		h, err := s.history(ctx, tx, userID, a)
		if err != nil {
			return err
		}
		if err := check(in, h); err != nil {
			return err
		}
		now := s.now()
		this := Year(now)

		// The account starts at 0 in the year it was opened.
		opb, err := q.ListOpeningBalances(ctx, sqlc.ListOpeningBalancesParams{UserID: userID, AccountID: id})
		if err != nil {
			return err
		}
		for _, o := range opb {
			if _, err := s.ledger.Record(ctx, tx, ledger.Entry{
				UserID: userID, CreatedBy: userID, Type: sqlc.TransactionTypeOPB, Correction: sqlc.CorrectionTypeAdjustment,
				ParentID: o.ID, At: o.TransactionAt, Description: Description(in.OpenedYear),
				BankLines: []ledger.BankLine{{AccountID: id, Amount: o.Net.Neg()}},
			}); err != nil {
				return fmt.Errorf("correct the opening balance: %w", err)
			}
		}

		recorded := map[int]Sums{}
		for _, y := range h.Years {
			recorded[y.Year] = y.Recorded
		}
		interestFrom := strings.TrimSpace(in.InterestCounterparty)
		if interestFrom == "" {
			interestFrom = a.Bank
		}
		for _, y := range in.Years {
			at := now
			if y.Year < this {
				at = time.Date(y.Year, 12, 31, 12, 0, 0, 0, oslo)
			}
			r := recorded[y.Year]
			for _, e := range []struct {
				typ          sqlc.TransactionType
				amount       decimal.Decimal
				tags         []string
				counterparty string
			}{
				{sqlc.TransactionTypeINC, y.Deposits.Sub(r.Deposits), nil, ""},
				{sqlc.TransactionTypeINC, y.Interest.Sub(r.Interest), []string{InterestTag}, interestFrom},
				{sqlc.TransactionTypeEXP, y.Withdrawals.Sub(r.Withdrawals).Neg(), nil, ""},
			} {
				if e.amount.IsZero() {
					continue
				}
				if _, err := s.ledger.Record(ctx, tx, ledger.Entry{
					UserID: userID, CreatedBy: userID, Type: e.typ, At: at,
					Description: Description(y.Year), Tags: e.tags, Counterparty: e.counterparty,
					BankLines: []ledger.BankLine{{AccountID: id, Amount: e.amount}},
				}); err != nil {
					return fmt.Errorf("record %d: %w", y.Year, err)
				}
			}
		}

		balances, err := balance.AccountsBefore(ctx, tx, userID, now.Add(time.Microsecond))
		if err != nil {
			return err
		}
		if diff := in.Balance.Sub(balances[id]); !diff.IsZero() {
			if _, err := s.ledger.Record(ctx, tx, ledger.Entry{
				UserID: userID, CreatedBy: userID, Type: sqlc.TransactionTypeBLA, At: now,
				Description: Description(this),
				BankLines:   []ledger.BankLine{{AccountID: id, Amount: diff}},
			}); err != nil {
				return fmt.Errorf("adjust the balance: %w", err)
			}
		}
		return q.SetBSUSetUp(ctx, sqlc.SetBSUSetUpParams{
			ID: id, UserID: userID, At: pgtype.Timestamptz{Time: now, Valid: true},
			OpenedYear: pgtype.Int2{Int16: int16(in.OpenedYear), Valid: true}, //nolint:gosec // checked
		})
	})
}

// check checks in against what the app has.
func check(in SetUpInput, h History) error {
	this := h.Years[len(h.Years)-1].Year
	if in.OpenedYear < MinOpenedYear || in.OpenedYear > h.LatestOpenedYear {
		return fmt.Errorf("%w: the year opened must be from %d to %d, the year of the first transaction in the app",
			ErrInvalid, MinOpenedYear, h.LatestOpenedYear)
	}
	if len(in.Years) != this-in.OpenedYear+1 {
		return fmt.Errorf("%w: give every year from %d to %d", ErrInvalid, in.OpenedYear, this)
	}
	recorded := map[int]Sums{}
	for _, y := range h.Years {
		recorded[y.Year] = y.Recorded
	}
	for i, y := range in.Years {
		if y.Year != in.OpenedYear+i {
			return fmt.Errorf("%w: give every year from %d to %d, in order", ErrInvalid, in.OpenedYear, this)
		}
		r := recorded[y.Year]
		for _, f := range []struct {
			name         string
			given, least decimal.Decimal
		}{
			{"deposits", y.Deposits, r.Deposits},
			{"interest", y.Interest, r.Interest},
			{"withdrawals", y.Withdrawals, r.Withdrawals},
		} {
			if err := money.Valid(f.given); err != nil {
				return fmt.Errorf("%w: %d %s: %w", ErrInvalid, y.Year, f.name, err)
			}
			if f.given.IsNegative() {
				return fmt.Errorf("%w: %d %s can't be negative", ErrInvalid, y.Year, f.name)
			}
			if f.given.LessThan(f.least) {
				return fmt.Errorf("%w: %d %s can't be below the %s the app has recorded", ErrInvalid, y.Year, f.name,
					f.least.StringFixed(money.Places))
			}
		}
	}
	if err := money.Valid(in.Balance); err != nil {
		return fmt.Errorf("%w: balance: %w", ErrInvalid, err)
	}
	return nil
}
