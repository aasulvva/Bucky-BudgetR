package stats_test

import (
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledgertest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/stats"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

func dec(s string) decimal.Decimal { return decimal.RequireFromString(s) }

func at(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func oslo(t *testing.T) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation("Europe/Oslo")
	if err != nil {
		t.Fatal(err)
	}
	return loc
}

// edges lists the intervals as "start..end" in loc, for comparing.
func edges(ivs []stats.Interval, loc *time.Location) []string {
	out := make([]string, len(ivs))
	for i, iv := range ivs {
		out[i] = iv.Start.In(loc).Format("01-02T15:04") + ".." + iv.End.In(loc).Format("01-02T15:04")
	}
	return out
}

func TestCut(t *testing.T) {
	loc := oslo(t)
	local := func(s string) time.Time {
		v, err := time.ParseInLocation("2006-01-02T15:04", s, loc)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	cut := func(from, to string, res stats.Resolution, week time.Weekday) []string {
		t.Helper()
		ivs, err := stats.Cut(local(from), local(to), res, loc, week)
		if err != nil {
			t.Fatal(err)
		}
		return edges(ivs, loc)
	}

	// Days across the end of summer time (25 October 2026): local midnights,
	// so that day is 25 hours long.
	days := cut("2026-10-24T00:00", "2026-10-27T00:00", stats.Day, time.Monday)
	if want := []string{"10-24T00:00..10-25T00:00", "10-25T00:00..10-26T00:00", "10-26T00:00..10-27T00:00"}; !slices.Equal(days, want) {
		t.Errorf("days = %v, want %v", days, want)
	}
	// The first and last are cut at the period's ends.
	months := cut("2026-01-15T12:00", "2026-03-10T00:00", stats.Month, time.Monday)
	if want := []string{"01-15T12:00..02-01T00:00", "02-01T00:00..03-01T00:00", "03-01T00:00..03-10T00:00"}; !slices.Equal(months, want) {
		t.Errorf("months = %v, want %v", months, want)
	}
	// Wednesday 11 November 2026: weeks from Monday or from Sunday.
	if got := cut("2026-11-11T00:00", "2026-11-12T00:00", stats.Week, time.Monday); got[0] != "11-11T00:00..11-12T00:00" {
		t.Errorf("week cut at the ends = %v", got)
	}
	if got := cut("2026-11-09T00:00", "2026-11-23T00:00", stats.Week, time.Monday); !slices.Equal(got, []string{"11-09T00:00..11-16T00:00", "11-16T00:00..11-23T00:00"}) {
		t.Errorf("Monday weeks = %v", got)
	}
	if got := cut("2026-11-09T00:00", "2026-11-23T00:00", stats.Week, time.Sunday); !slices.Equal(got, []string{"11-09T00:00..11-15T00:00", "11-15T00:00..11-22T00:00", "11-22T00:00..11-23T00:00"}) {
		t.Errorf("Sunday weeks = %v", got)
	}
	// Hours on the night summer time ends: 02:00 comes twice, 25 hours.
	if got := cut("2026-10-25T00:00", "2026-10-26T00:00", stats.Hour, time.Monday); len(got) != 25 {
		t.Errorf("hours on 25 October = %d, want 25", len(got))
	}
	if got := cut("2026-01-01T00:00", "2028-01-01T00:00", stats.Year, time.Monday); !slices.Equal(got, []string{"01-01T00:00..01-01T00:00", "01-01T00:00..01-01T00:00"}) {
		t.Errorf("years = %v", got)
	}
	// More than 1000 intervals.
	if _, err := stats.Cut(local("2026-01-01T00:00"), local("2027-01-01T00:00"), stats.Hour, loc, time.Monday); !errors.Is(err, stats.ErrTooMany) {
		t.Errorf("a year in hours: %v, want ErrTooMany", err)
	}
}

type env struct {
	t    *testing.T
	pool *pgxpool.Pool
	user string
	l    *ledger.Ledger
}

func (e env) record(entry ledger.Entry) *ledger.Transaction {
	e.t.Helper()
	entry.UserID = e.user
	tx, err := e.l.Create(e.t.Context(), e.pool, entry)
	if err != nil {
		e.t.Fatal(err)
	}
	return tx
}

type bank struct {
	id, amount string
}

func lines(ls ...bank) []ledger.BankLine {
	out := make([]ledger.BankLine, len(ls))
	for i, b := range ls {
		out[i] = ledger.BankLine{AccountID: b.id, Amount: dec(b.amount)}
	}
	return out
}

func bucketLines(ls ...bank) []ledger.BucketLine {
	out := make([]ledger.BucketLine, len(ls))
	for i, b := range ls {
		out[i] = ledger.BucketLine{BucketID: b.id, Amount: dec(b.amount)}
	}
	return out
}

// values is a series's values as strings, or nil if there's no such series.
func values(res stats.Result, match func(stats.Line) bool) []string {
	for _, l := range res.Series {
		if match(l) {
			out := make([]string, len(l.Values))
			for i, v := range l.Values {
				out[i] = v.StringFixed(2)
			}
			return out
		}
	}
	return nil
}

func TestSeries(t *testing.T) {
	pool := testdb.New(t)
	ctx := t.Context()
	loc := oslo(t)
	user := authtest.NewUser(t, pool, "alice").ID
	e := env{t: t, pool: pool, user: user, l: ledger.New(ledger.Options{})}
	main := ledgertest.Account(t, pool, user, "")
	savings := ledgertest.Account(t, pool, user, "")
	euro := ledgertest.Account(t, pool, user, "EUR")
	// November 2026 in Oslo, and its cycle.
	nov, dec1 := at("2026-10-31T23:00:00Z"), at("2026-11-30T23:00:00Z")
	ledgertest.Cycle(t, pool, user, nov, dec1, "active")
	food := ledgertest.Bucket(t, pool, user, main)
	fun := ledgertest.Bucket(t, pool, user, main)

	e.record(ledger.Entry{Type: sqlc.TransactionTypeOPB, At: at("2026-10-01T08:00:00Z"), BankLines: lines(bank{main, "10000"})})
	// 1 November: salary, and food bought partly from the bucket.
	e.record(ledger.Entry{Type: sqlc.TransactionTypeINC, At: at("2026-11-01T08:00:00Z"), Counterparty: "Employer", BankLines: lines(bank{main, "20000"})})
	e.record(ledger.Entry{
		Type: sqlc.TransactionTypeEXP, At: at("2026-11-01T12:00:00Z"), Counterparty: "Rema 1000", Tags: []string{"Groceries"},
		BankLines: lines(bank{main, "-500"}), BucketLines: bucketLines(bank{food, "-400"}),
	})
	// 2 November: an expense corrected later counts on its own date.
	exp := e.record(ledger.Entry{
		Type: sqlc.TransactionTypeEXP, At: at("2026-11-02T12:00:00Z"), Counterparty: "Kino", Tags: []string{"fun"},
		BankLines: lines(bank{main, "-300"}), BucketLines: bucketLines(bank{fun, "-300"}),
	})
	e.record(ledger.Entry{
		Type: sqlc.TransactionTypeEXP, At: at("2026-11-05T12:00:00Z"), Correction: sqlc.CorrectionTypeAdjustment, ParentID: exp.Header.ID,
		Counterparty: "Kino", Tags: []string{"fun"}, // a correction carries the effective values
		BankLines: lines(bank{main, "-50"}), BucketLines: bucketLines(bank{fun, "-50"}),
	})
	// 3 November: reversed, so it counts as nothing.
	oops := e.record(ledger.Entry{Type: sqlc.TransactionTypeEXP, At: at("2026-11-03T12:00:00Z"), BankLines: lines(bank{main, "-1000"})})
	e.record(ledger.Entry{
		Type: sqlc.TransactionTypeEXP, At: at("2026-11-03T12:00:00Z"), Correction: sqlc.CorrectionTypeReversal, ParentID: oops.Header.ID,
		BankLines: lines(bank{main, "1000"}),
	})
	// 3 November: a transfer, and a balance adjustment (only in balances).
	e.record(ledger.Entry{Type: sqlc.TransactionTypeTRF, At: at("2026-11-03T13:00:00Z"), BankLines: lines(bank{main, "-2000"}, bank{savings, "2000"})})
	e.record(ledger.Entry{Type: sqlc.TransactionTypeBLA, At: at("2026-11-03T14:00:00Z"), BankLines: lines(bank{savings, "12"})})
	// An expense in euros, kept apart.
	e.record(ledger.Entry{Type: sqlc.TransactionTypeEXP, At: at("2026-11-02T09:00:00Z"), BankLines: lines(bank{euro, "-20"})})
	// Another user's don't count.
	bob := authtest.NewUser(t, pool, "bob").ID
	bobs := ledgertest.Account(t, pool, bob, "")
	if _, err := e.l.Create(ctx, pool, ledger.Entry{UserID: bob, Type: sqlc.TransactionTypeEXP, At: at("2026-11-01T12:00:00Z"), BankLines: lines(bank{bobs, "-5"})}); err != nil {
		t.Fatal(err)
	}

	// 1–4 November by day.
	query := func(q stats.Query) stats.Result {
		t.Helper()
		if q.From.IsZero() {
			q.From, q.To = nov, at("2026-11-04T23:00:00Z")
		}
		if q.Resolution == "" {
			q.Resolution = stats.Day
		}
		q.Location = loc
		res, err := stats.Series(ctx, pool, user, q)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	nok := func(l stats.Line) bool { return l.Currency == "NOK" }
	eur := func(l stats.Line) bool { return l.Currency == "EUR" }
	account := func(id string) func(stats.Line) bool {
		return func(l stats.Line) bool { return l.AccountID == id }
	}
	bucket := func(id string) func(stats.Line) bool {
		return func(l stats.Line) bool { return l.BucketID == id }
	}
	check := func(name string, got, want []string) {
		t.Helper()
		if !slices.Equal(got, want) {
			t.Errorf("%s = %v, want %v", name, got, want)
		}
	}

	spending := query(stats.Query{Metric: stats.Spending})
	if len(spending.Intervals) != 4 {
		t.Fatalf("intervals = %v", edges(spending.Intervals, loc))
	}
	check("spending NOK", values(spending, nok), []string{"500.00", "350.00", "0.00", "0.00"})
	check("spending EUR", values(spending, eur), []string{"0.00", "20.00", "0.00", "0.00"})
	if len(spending.Series) != 2 {
		t.Errorf("series = %d, want one per currency", len(spending.Series))
	}
	check("income", values(query(stats.Query{Metric: stats.Income}), nok), []string{"20000.00", "0.00", "0.00", "0.00"})

	// Transfers count on the side that matches.
	check("main's spending with transfers", values(query(stats.Query{Metric: stats.Spending, AccountIDs: []string{main}, Transfers: true}), nok),
		[]string{"500.00", "350.00", "2000.00", "0.00"})
	check("savings' income with transfers", values(query(stats.Query{Metric: stats.Income, AccountIDs: []string{savings}, Transfers: true}), nok),
		[]string{"0.00", "0.00", "2000.00", "0.00"})

	// By account: every account gets a series, even without spending.
	byAccount := query(stats.Query{Metric: stats.Spending, GroupBy: stats.ByAccount})
	check("by account: main", values(byAccount, account(main)), []string{"500.00", "350.00", "0.00", "0.00"})
	check("by account: savings", values(byAccount, account(savings)), []string{"0.00", "0.00", "0.00", "0.00"})
	check("by account: euro", values(byAccount, account(euro)), []string{"0.00", "20.00", "0.00", "0.00"})

	// By bucket: what's on no bucket is its own series per currency.
	byBucket := query(stats.Query{Metric: stats.Spending, GroupBy: stats.ByBucket})
	check("by bucket: food", values(byBucket, bucket(food)), []string{"400.00", "0.00", "0.00", "0.00"})
	check("by bucket: fun", values(byBucket, bucket(fun)), []string{"0.00", "350.00", "0.00", "0.00"})
	check("by bucket: none (NOK)", values(byBucket, func(l stats.Line) bool { return l.NoBucket && l.Currency == "NOK" }),
		[]string{"100.00", "0.00", "0.00", "0.00"})
	check("by bucket: none (EUR)", values(byBucket, func(l stats.Line) bool { return l.NoBucket && l.Currency == "EUR" }),
		[]string{"0.00", "20.00", "0.00", "0.00"})
	if last := byBucket.Series[len(byBucket.Series)-1]; !last.NoBucket {
		t.Errorf("the series on no bucket isn't last in its currency: %+v", byBucket.Series)
	}
	// A bucket filter uses only that bucket's lines.
	check("food only", values(query(stats.Query{Metric: stats.Spending, BucketIDs: []string{food}}), nok), []string{"400.00", "0.00", "0.00", "0.00"})

	// Tags (any of them, ignoring case) and counterparty.
	check("tags", values(query(stats.Query{Metric: stats.Spending, Tags: []string{"groceries", "FUN"}}), nok), []string{"500.00", "350.00", "0.00", "0.00"})
	check("one tag", values(query(stats.Query{Metric: stats.Spending, Tags: []string{"fun"}}), nok), []string{"0.00", "350.00", "0.00", "0.00"})
	check("counterparty", values(query(stats.Query{Metric: stats.Spending, Counterparty: "rema"}), nok), []string{"500.00", "0.00", "0.00", "0.00"})
	check("counterparty with LIKE characters", values(query(stats.Query{Metric: stats.Spending, Counterparty: "%"}), nok), []string{"0.00", "0.00", "0.00", "0.00"})

	// Balances at the end of each day, from the balance before the period.
	// Each line counts on its own transaction's date, as account balances
	// do, so the correction on 5 November isn't in yet.
	balances := query(stats.Query{Metric: stats.Balance, GroupBy: stats.ByAccount})
	check("main's balance", values(balances, account(main)), []string{"29500.00", "29200.00", "27200.00", "27200.00"})
	check("savings' balance", values(balances, account(savings)), []string{"0.00", "0.00", "2012.00", "2012.00"})
	check("total NOK balance", values(query(stats.Query{Metric: stats.Balance}), nok), []string{"29500.00", "29200.00", "29212.00", "29212.00"})

	// The whole period, and its cycle.
	check("total", values(query(stats.Query{Metric: stats.Spending, Resolution: stats.Total}), nok), []string{"850.00"})
	cycle := query(stats.Query{Metric: stats.Spending, Resolution: stats.Cycle, From: at("2026-10-15T00:00:00Z"), To: at("2026-12-15T00:00:00Z")})
	if got := edges(cycle.Intervals, loc); !slices.Equal(got, []string{"11-01T00:00..12-01T00:00"}) {
		t.Errorf("cycle intervals = %v", got)
	}
	check("cycle", values(cycle, nok), []string{"850.00"})
	check("balance by cycle", values(query(stats.Query{Metric: stats.Balance, Resolution: stats.Cycle, From: at("2026-10-15T00:00:00Z"), To: at("2026-12-15T00:00:00Z")}), nok),
		[]string{"29162.00"})

	// Questions that can't be answered.
	for name, q := range map[string]stats.Query{
		"empty period":       {Metric: stats.Spending, From: nov, To: nov, Resolution: stats.Day},
		"balance by bucket":  {Metric: stats.Balance, From: nov, To: dec1, Resolution: stats.Day, GroupBy: stats.ByBucket},
		"balance with a tag": {Metric: stats.Balance, From: nov, To: dec1, Resolution: stats.Day, Tags: []string{"x"}},
		"unknown metric":     {Metric: "profit", From: nov, To: dec1, Resolution: stats.Day},
		"unknown resolution": {Metric: stats.Spending, From: nov, To: dec1, Resolution: "fortnight"},
		"unknown grouping":   {Metric: stats.Spending, From: nov, To: dec1, Resolution: stats.Day, GroupBy: "tag"},
	} {
		if _, err := stats.Series(ctx, pool, user, q); !errors.Is(err, stats.ErrInvalid) {
			t.Errorf("%s: %v, want ErrInvalid", name, err)
		}
	}
	if _, err := stats.Series(ctx, pool, user, stats.Query{Metric: stats.Spending, From: nov, To: at("2028-01-01T00:00:00Z"), Resolution: stats.Hour}); !errors.Is(err, stats.ErrTooMany) {
		t.Errorf("too many hours: %v", err)
	}
}
