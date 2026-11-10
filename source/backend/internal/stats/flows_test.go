package stats_test

import (
	"errors"
	"slices"
	"testing"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledgertest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/stats"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

func TestFlows(t *testing.T) {
	pool := testdb.New(t)
	ctx := t.Context()
	loc := oslo(t)
	user := authtest.NewUser(t, pool, "alice").ID
	e := env{t: t, pool: pool, user: user, l: ledger.New(ledger.Options{})}
	main := ledgertest.Account(t, pool, user, "")
	savings := ledgertest.Account(t, pool, user, "")
	food := ledgertest.Bucket(t, pool, user, main)
	fun := ledgertest.Bucket(t, pool, user, main)
	// October 2026 in Oslo as one cycle, then November as the next.
	oct, nov, dec1 := at("2026-09-30T22:00:00Z"), at("2026-10-31T23:00:00Z"), at("2026-11-30T23:00:00Z")
	october := ledgertest.Cycle(t, pool, user, oct, nov, "active")

	e.record(ledger.Entry{Type: sqlc.TransactionTypeOPB, At: at("2026-10-01T08:00:00Z"), BankLines: lines(bank{main, "10000"})})
	// October: opening funds and a refill, spending, an adjustment down, a
	// transfer between the buckets.
	e.record(ledger.Entry{Type: sqlc.TransactionTypeOPF, At: at("2026-10-01T09:00:00Z"), BucketLines: bucketLines(bank{food, "100"})})
	e.record(ledger.Entry{Type: sqlc.TransactionTypeREF, At: at("2026-10-01T10:00:00Z"), BucketLines: bucketLines(bank{food, "3000"})})
	e.record(ledger.Entry{Type: sqlc.TransactionTypeREF, At: at("2026-10-01T10:00:00Z"), BucketLines: bucketLines(bank{fun, "1000"})})
	exp := e.record(ledger.Entry{
		Type: sqlc.TransactionTypeEXP, At: at("2026-10-05T12:00:00Z"),
		BankLines: lines(bank{main, "-500"}), BucketLines: bucketLines(bank{food, "-500"}),
	})
	// Corrected to 450 later: counts on the original's date.
	e.record(ledger.Entry{
		Type: sqlc.TransactionTypeEXP, At: at("2026-10-06T12:00:00Z"), Correction: sqlc.CorrectionTypeAdjustment, ParentID: exp.Header.ID,
		BankLines: lines(bank{main, "50"}), BucketLines: bucketLines(bank{food, "50"}),
	})
	// Reversed: nothing.
	oops := e.record(ledger.Entry{
		Type: sqlc.TransactionTypeEXP, At: at("2026-10-07T12:00:00Z"),
		BankLines: lines(bank{main, "-80"}), BucketLines: bucketLines(bank{fun, "-80"}),
	})
	e.record(ledger.Entry{
		Type: sqlc.TransactionTypeEXP, At: at("2026-10-07T12:00:00Z"), Correction: sqlc.CorrectionTypeReversal, ParentID: oops.Header.ID,
		BankLines: lines(bank{main, "80"}), BucketLines: bucketLines(bank{fun, "80"}),
	})
	e.record(ledger.Entry{Type: sqlc.TransactionTypeBUA, At: at("2026-10-10T12:00:00Z"), BucketLines: bucketLines(bank{fun, "-200"})})
	e.record(ledger.Entry{Type: sqlc.TransactionTypeBAT, At: at("2026-10-11T12:00:00Z"), BucketLines: bucketLines(bank{food, "-300"}, bank{fun, "300"})})
	e.record(ledger.Entry{Type: sqlc.TransactionTypeINC, At: at("2026-10-15T08:00:00Z"), BankLines: lines(bank{main, "20000"})})
	e.record(ledger.Entry{Type: sqlc.TransactionTypeTRF, At: at("2026-10-16T08:00:00Z"), BankLines: lines(bank{main, "-2000"}, bank{savings, "2000"})})

	// November: the next cycle, with an overflow and an adjustment up.
	if _, err := pool.Exec(ctx, `UPDATE cycles SET state = 'finished' WHERE id = $1`, october); err != nil {
		t.Fatal(err)
	}
	ledgertest.Cycle(t, pool, user, nov, dec1, "active")
	e.record(ledger.Entry{Type: sqlc.TransactionTypeOVF, At: at("2026-11-01T00:30:00Z"), BucketLines: bucketLines(bank{food, "-150"})})
	e.record(ledger.Entry{Type: sqlc.TransactionTypeBUA, At: at("2026-11-02T12:00:00Z"), BucketLines: bucketLines(bank{fun, "50"})})

	query := func(q stats.FlowsQuery) stats.FlowsResult {
		t.Helper()
		if q.From.IsZero() {
			q.From, q.To = oct, dec1
		}
		q.Location = loc
		res, err := stats.Flows(ctx, pool, user, q)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	type row = []string // start, in, out, end
	figures := func(res stats.FlowsResult, bucket string) []row {
		t.Helper()
		for _, b := range res.Buckets {
			if b.BucketID == bucket {
				out := make([]row, len(b.Values))
				for i, v := range b.Values {
					if !v.Start.Add(v.In).Sub(v.Out).Equal(v.End) {
						t.Errorf("%s interval %d doesn't add up: %+v", bucket, i, v)
					}
					out[i] = row{v.Start.StringFixed(2), v.In.StringFixed(2), v.Out.StringFixed(2), v.End.StringFixed(2)}
				}
				return out
			}
		}
		t.Fatalf("no bucket %s", bucket)
		return nil
	}

	months := query(stats.FlowsQuery{Resolution: stats.Month})
	if len(months.Intervals) != 2 {
		t.Fatalf("intervals = %v", edges(months.Intervals, loc))
	}
	// Food: 100 + 3000 in; 450 spent and 300 to Fun out; then 150 overflow.
	if got, want := figures(months, food), []row{{"0.00", "3100.00", "750.00", "2350.00"}, {"2350.00", "0.00", "150.00", "2200.00"}}; !slices.EqualFunc(got, want, slices.Equal) {
		t.Errorf("food by month = %v, want %v", got, want)
	}
	// Fun: 1000 + 300 in, 200 adjusted out (the reversed expense is nothing); then 50 in.
	if got, want := figures(months, fun), []row{{"0.00", "1300.00", "200.00", "1100.00"}, {"1100.00", "50.00", "0.00", "1150.00"}}; !slices.EqualFunc(got, want, slices.Equal) {
		t.Errorf("fun by month = %v, want %v", got, want)
	}
	f := months.Buckets[slices.IndexFunc(months.Buckets, func(b stats.BucketFlow) bool { return b.BucketID == food })].Values[0]
	for name, pair := range map[string][2]string{
		"opening": {f.Opening.StringFixed(2), "100.00"}, "refills": {f.Refills.StringFixed(2), "3000.00"},
		"spent": {f.Spent.StringFixed(2), "450.00"}, "transfers out": {f.TransfersOut.StringFixed(2), "300.00"},
	} {
		if pair[0] != pair[1] {
			t.Errorf("food in October: %s = %s, want %s", name, pair[0], pair[1])
		}
	}

	// Per cycle, the same; for November only, it starts with October's end.
	if got := figures(query(stats.FlowsQuery{Resolution: stats.Cycle}), food); len(got) != 2 || got[1][3] != "2200.00" {
		t.Errorf("food by cycle = %v", got)
	}
	if got := figures(query(stats.FlowsQuery{From: nov, To: dec1, Resolution: stats.Total}), fun); !slices.Equal(got[0], row{"1100.00", "50.00", "0.00", "1150.00"}) {
		t.Errorf("fun in November = %v", got)
	}

	// Accounts: income, expenses and transfers, net of corrections.
	total := query(stats.FlowsQuery{Resolution: stats.Total})
	for _, a := range total.Accounts {
		v := a.Values[0]
		got := []string{v.Income.StringFixed(2), v.Expenses.StringFixed(2), v.TransfersIn.StringFixed(2), v.TransfersOut.StringFixed(2)}
		want := map[string][]string{main: {"20000.00", "450.00", "0.00", "2000.00"}, savings: {"0.00", "0.00", "2000.00", "0.00"}}[a.AccountID]
		if !slices.Equal(got, want) {
			t.Errorf("account %s = %v, want %v", a.AccountID, got, want)
		}
	}

	// Filters: one bucket, or one account's buckets and itself.
	if res := query(stats.FlowsQuery{Resolution: stats.Total, BucketIDs: []string{fun}}); len(res.Buckets) != 1 || res.Buckets[0].BucketID != fun {
		t.Errorf("bucket filter = %+v", res.Buckets)
	}
	if res := query(stats.FlowsQuery{Resolution: stats.Total, AccountIDs: []string{savings}}); len(res.Buckets) != 0 || len(res.Accounts) != 1 {
		t.Errorf("account filter = %+v / %+v", res.Buckets, res.Accounts)
	}
	// Another user sees none of it.
	bob := authtest.NewUser(t, pool, "bob").ID
	if res, err := stats.Flows(ctx, pool, bob, stats.FlowsQuery{From: oct, To: dec1, Resolution: stats.Total}); err != nil || len(res.Buckets) != 0 || len(res.Accounts) != 0 {
		t.Errorf("bob = %+v, %v", res, err)
	}

	for name, q := range map[string]stats.FlowsQuery{
		"days":      {From: oct, To: dec1, Resolution: stats.Day},
		"backwards": {From: dec1, To: oct, Resolution: stats.Total},
	} {
		if _, err := stats.Flows(ctx, pool, user, q); !errors.Is(err, stats.ErrInvalid) {
			t.Errorf("%s: %v, want ErrInvalid", name, err)
		}
	}
}
