// Package bsu holds the rules for BSU accounts (Boligsparing for ungdom,
// #214, spec §3): a Norwegian housing-savings account, always in NOK, with a
// yearly and a total limit on what may be deposited. Admins set the limits
// per year (bsu_rules), since they change by law.
//
// A deposit is an income (INC) or transfer (TRF) into the account; interest
// (an income tagged interest, #70), the opening balance (OPB) and balance
// adjustments (BLA) aren't. A withdrawal is an expense (EXP) or a transfer
// out; it doesn't lower what's deposited. Each transaction family (an
// original and its corrections) counts its net on the account, on the
// original's date, so a reversed one counts as nothing. Years are calendar
// years in Norwegian time (Europe/Oslo), whatever the user's time zone.
//
// Each BSU account is locked until its history is set up (history.go): what
// was deposited, earned in interest and withdrawn each year it's been open.
package bsu

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	_ "time/tzdata" // Europe/Oslo without the system's zoneinfo

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
)

// Currency is the only currency a BSU account can have.
const Currency = "NOK"

// InterestTag marks an income as registered interest (#70), which isn't a
// deposit.
const InterestTag = "interest"

var (
	// ErrInvalid means the input breaks a rule.
	ErrInvalid = errors.New("invalid BSU input")
	// ErrNotFound means there's no such rule or account.
	ErrNotFound = errors.New("not found")
	// ErrLastRule means the last rule can't be deleted: every year needs one.
	ErrLastRule = errors.New("the last BSU rule can't be deleted")
	// ErrOverLimit means a deposit goes over the yearly or total limit.
	ErrOverLimit = errors.New("the deposit goes over the BSU limit")
	// ErrWithdrawal means money is taken out of a BSU, which can end its tax
	// benefit.
	ErrWithdrawal = errors.New("money is taken out of a BSU account")
	// ErrSetUp means the account's history is set up already.
	ErrSetUp = errors.New("the BSU history is set up already")
	// ErrNotBSU means the account isn't a BSU account in NOK.
	ErrNotBSU = errors.New("the account isn't a BSU account in NOK")
)

// OverLimitError says which account a deposit takes over a limit, and what
// was left of it.
type OverLimitError struct {
	AccountID string
	Year      int
	// LeftYear and LeftTotal are what may still be deposited.
	LeftYear, LeftTotal decimal.Decimal
}

func (e *OverLimitError) Error() string {
	return fmt.Sprintf("%s: account %s, %s left in %d, %s in total", ErrOverLimit, e.AccountID,
		e.LeftYear.StringFixed(money.Places), e.Year, e.LeftTotal.StringFixed(money.Places))
}

func (e *OverLimitError) Unwrap() error { return ErrOverLimit }

// WithdrawalError says which BSU account money leaves.
type WithdrawalError struct{ AccountID string }

func (e *WithdrawalError) Error() string {
	return fmt.Sprintf("%s: account %s", ErrWithdrawal, e.AccountID)
}

func (e *WithdrawalError) Unwrap() error { return ErrWithdrawal }

var oslo = mustZone("Europe/Oslo")

func mustZone(name string) *time.Location {
	l, err := time.LoadLocation(name)
	if err != nil {
		panic(err)
	}
	return l
}

// Year is the calendar year at holds in Norwegian time.
func Year(at time.Time) int { return at.In(oslo).Year() }

// YearBounds is the year's start and the next year's, in UTC.
func YearBounds(year int) (time.Time, time.Time) {
	return time.Date(year, 1, 1, 0, 0, 0, 0, oslo).UTC(), time.Date(year+1, 1, 1, 0, 0, 0, 0, oslo).UTC()
}

// Rule is the limits from a year on.
type Rule struct {
	FromYear    int
	YearlyLimit decimal.Decimal
	TotalLimit  decimal.Decimal
	ModifiedAt  time.Time
}

// Service manages the rules and the accounts' history setup.
type Service struct {
	pool   *pgxpool.Pool
	ledger *ledger.Ledger
	now    func() time.Time
}

// Options configures a Service.
type Options struct {
	// Now returns the current time. Defaults to time.Now.
	Now func() time.Time
}

// NewService returns a Service that records the history setup in l.
func NewService(pool *pgxpool.Pool, l *ledger.Ledger, opts Options) *Service {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Service{pool: pool, ledger: l, now: opts.Now}
}

// Rules returns the rules, oldest first.
func (s *Service) Rules(ctx context.Context) ([]Rule, error) {
	return rules(ctx, sqlc.New(s.pool))
}

// SetRule creates or changes the rule from year, by the admin adminID. It
// returns the rule before (nil if new) and after.
func (s *Service) SetRule(ctx context.Context, adminID string, r Rule) (*Rule, Rule, error) {
	if r.FromYear < 2000 || r.FromYear > 2100 {
		return nil, Rule{}, fmt.Errorf("%w: the year must be from 2000 to 2100", ErrInvalid)
	}
	for _, d := range []decimal.Decimal{r.YearlyLimit, r.TotalLimit} {
		if err := money.Valid(d); err != nil {
			return nil, Rule{}, fmt.Errorf("%w: %w", ErrInvalid, err)
		}
	}
	if !r.YearlyLimit.IsPositive() {
		return nil, Rule{}, fmt.Errorf("%w: the yearly limit must be above 0", ErrInvalid)
	}
	if r.TotalLimit.LessThan(r.YearlyLimit) {
		return nil, Rule{}, fmt.Errorf("%w: the total limit can't be below the yearly limit", ErrInvalid)
	}
	var before *Rule
	var after Rule
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := sqlc.New(tx)
		if _, err := tx.Exec(ctx, "LOCK TABLE bsu_rules IN SHARE ROW EXCLUSIVE MODE"); err != nil {
			return err
		}
		list, err := rules(ctx, q)
		if err != nil {
			return err
		}
		if i := slices.IndexFunc(list, func(x Rule) bool { return x.FromYear == r.FromYear }); i >= 0 {
			before = &list[i]
		}
		row, err := q.UpsertBSURule(ctx, sqlc.UpsertBSURuleParams{
			FromYear: int16(r.FromYear), YearlyLimit: r.YearlyLimit, TotalLimit: r.TotalLimit, //nolint:gosec // checked above
			UpdatedBy: pgtype.Text{String: adminID, Valid: adminID != ""},
		})
		after = toRule(row)
		return err
	})
	if err != nil {
		return nil, Rule{}, err
	}
	return before, after, nil
}

// DeleteRule deletes the rule from year, returning it. The last one stays.
func (s *Service) DeleteRule(ctx context.Context, year int) (Rule, error) {
	var out Rule
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "LOCK TABLE bsu_rules IN SHARE ROW EXCLUSIVE MODE"); err != nil {
			return err
		}
		q := sqlc.New(tx)
		list, err := rules(ctx, q)
		if err != nil {
			return err
		}
		i := slices.IndexFunc(list, func(x Rule) bool { return x.FromYear == year })
		if i < 0 {
			return fmt.Errorf("%w: no BSU rule from %d", ErrNotFound, year)
		}
		if len(list) == 1 {
			return ErrLastRule
		}
		out = list[i]
		_, err = q.DeleteBSURule(ctx, int16(year)) //nolint:gosec // a rule's year
		return err
	})
	return out, err
}

func rules(ctx context.Context, q *sqlc.Queries) ([]Rule, error) {
	rows, err := q.ListBSURules(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Rule, len(rows))
	for i, r := range rows {
		out[i] = toRule(r)
	}
	return out, nil
}

func toRule(r sqlc.BsuRule) Rule {
	return Rule{FromYear: int(r.FromYear), YearlyLimit: r.YearlyLimit, TotalLimit: r.TotalLimit, ModifiedAt: r.ModifiedAt}
}

// For returns the rule for year: the one with the latest from-year at or
// before it, or the first for years before them all. list is oldest first
// and not empty.
func For(list []Rule, year int) Rule {
	out := list[0]
	for _, r := range list {
		if r.FromYear <= year {
			out = r
		}
	}
	return out
}

// Sums is what a year's transactions add up to on an account.
type Sums struct {
	Deposits, Interest, Withdrawals decimal.Decimal
}

// Counts is how many transactions make up each of a year's Sums.
type Counts struct {
	Deposits, Interest, Withdrawals int
}

// tally is a year's sums and how many transactions make them up.
type tally struct {
	Sums
	Count Counts
}

// yearSums returns each account's sums per year.
func yearSums(ctx context.Context, q *sqlc.Queries, userID string, accountIDs []string) (map[string]map[int]Sums, error) {
	t, err := yearTallies(ctx, q, userID, accountIDs)
	if err != nil {
		return nil, err
	}
	out := make(map[string]map[int]Sums, len(t))
	for id, years := range t {
		out[id] = make(map[int]Sums, len(years))
		for y, s := range years {
			out[id][y] = s.Sums
		}
	}
	return out, nil
}

// yearTallies returns each account's sums per year, with their counts.
func yearTallies(ctx context.Context, q *sqlc.Queries, userID string, accountIDs []string) (map[string]map[int]tally, error) {
	out := map[string]map[int]tally{}
	if len(accountIDs) == 0 {
		return out, nil
	}
	rows, err := q.BSUFamilyNets(ctx, sqlc.BSUFamilyNetsParams{UserID: userID, AccountIds: accountIDs})
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		if out[r.AccountID] == nil {
			out[r.AccountID] = map[int]tally{}
		}
		y := Year(r.TransactionAt)
		s := out[r.AccountID][y]
		switch {
		case r.Net.IsPositive() && r.TransactionType == sqlc.TransactionTypeINC && r.Interest:
			s.Interest = s.Interest.Add(r.Net)
			s.Count.Interest++
		case r.Net.IsPositive() && r.TransactionType != sqlc.TransactionTypeEXP:
			s.Deposits = s.Deposits.Add(r.Net)
			s.Count.Deposits++
		case r.Net.IsNegative() && r.TransactionType != sqlc.TransactionTypeINC:
			s.Withdrawals = s.Withdrawals.Sub(r.Net)
			s.Count.Withdrawals++
		}
		out[r.AccountID][y] = s
	}
	return out, nil
}

// Status is a BSU account's deposits against the limits of a year.
type Status struct {
	Year        int
	YearlyLimit decimal.Decimal
	TotalLimit  decimal.Decimal
	// DepositedYear is the year's deposits, DepositedTotal all deposits.
	DepositedYear  decimal.Decimal
	DepositedTotal decimal.Decimal
	// LeftYear and LeftTotal are what may still be deposited, at least 0.
	LeftYear  decimal.Decimal
	LeftTotal decimal.Decimal
	// Over means the deposits are over a limit.
	Over bool
	// Locked means the history isn't set up yet: nothing may be recorded
	// with the account until it is.
	Locked bool
	// OpenedYear is the year it was opened, from the history setup; 0
	// before it.
	OpenedYear int
}

// Statuses returns the status in the year at holds of each of these accounts
// that is a BSU account.
func Statuses(ctx context.Context, db sqlc.DBTX, userID string, accounts []sqlc.BankAccount, at time.Time) (map[string]Status, error) {
	var ids []string
	for _, a := range accounts {
		if a.AccountType == sqlc.AccountTypeBsu {
			ids = append(ids, a.ID)
		}
	}
	out := make(map[string]Status, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	q := sqlc.New(db)
	list, err := rules(ctx, q)
	if err != nil {
		return nil, err
	}
	sums, err := yearSums(ctx, q, userID, ids)
	if err != nil {
		return nil, err
	}
	year := Year(at)
	rule := For(list, year)
	for _, a := range accounts {
		if a.AccountType != sqlc.AccountTypeBsu {
			continue
		}
		st := Status{
			Year: year, YearlyLimit: rule.YearlyLimit, TotalLimit: rule.TotalLimit,
			DepositedYear: sums[a.ID][year].Deposits, DepositedTotal: decimal.Zero,
			Locked: !a.BsuSetUpAt.Valid || a.Currency != Currency, OpenedYear: int(a.BsuOpenedYear.Int16),
		}
		for _, s := range sums[a.ID] {
			st.DepositedTotal = st.DepositedTotal.Add(s.Deposits)
		}
		st.LeftYear = decimal.Max(rule.YearlyLimit.Sub(st.DepositedYear), decimal.Zero)
		st.LeftTotal = decimal.Max(rule.TotalLimit.Sub(st.DepositedTotal), decimal.Zero)
		st.Over = st.DepositedYear.GreaterThan(rule.YearlyLimit) || st.DepositedTotal.GreaterThan(rule.TotalLimit)
		out[a.ID] = st
	}
	return out, nil
}

// Change is a transaction family's net on an account before and after it's
// recorded or corrected (Before is 0 for a new one).
type Change struct {
	AccountID     string
	Before, After decimal.Decimal
}

// Check checks a transaction of type typ dated at (the original's date for a
// correction) against the BSU accounts among changes: what it adds to a
// deposit can't take the account over the limits of at's year
// (*OverLimitError), and it can't take money out (*WithdrawalError). An
// interest income is never a deposit. The caller holds the user's lock.
func Check(ctx context.Context, db sqlc.DBTX, userID string, typ sqlc.TransactionType, tags []string, at time.Time, changes []Change) error {
	if typ != sqlc.TransactionTypeINC && typ != sqlc.TransactionTypeTRF && typ != sqlc.TransactionTypeEXP {
		return nil
	}
	q := sqlc.New(db)
	var accounts []sqlc.BankAccount
	for _, c := range changes {
		a, err := q.GetAccount(ctx, sqlc.GetAccountParams{ID: c.AccountID, UserID: userID})
		if errors.Is(err, pgx.ErrNoRows) {
			continue // the caller's own checks say so
		}
		if err != nil {
			return err
		}
		if a.AccountType == sqlc.AccountTypeBsu {
			accounts = append(accounts, a)
		}
	}
	if len(accounts) == 0 {
		return nil
	}
	interest := typ == sqlc.TransactionTypeINC && slices.ContainsFunc(tags, func(t string) bool {
		return strings.EqualFold(strings.TrimSpace(t), InterestTag)
	})
	st, err := Statuses(ctx, db, userID, accounts, at)
	if err != nil {
		return err
	}
	for _, c := range changes {
		s, ok := st[c.AccountID]
		if !ok {
			continue
		}
		// More taken out than before.
		if c.After.IsNegative() && c.After.LessThan(decimal.Min(c.Before, decimal.Zero)) {
			return &WithdrawalError{AccountID: c.AccountID}
		}
		if interest || typ == sqlc.TransactionTypeEXP {
			continue
		}
		added := c.After.Sub(decimal.Max(c.Before, decimal.Zero))
		if !c.After.IsPositive() || !added.IsPositive() {
			continue
		}
		if added.GreaterThan(s.LeftYear) || added.GreaterThan(s.LeftTotal) {
			return &OverLimitError{AccountID: c.AccountID, Year: s.Year, LeftYear: s.LeftYear, LeftTotal: s.LeftTotal}
		}
	}
	return nil
}
