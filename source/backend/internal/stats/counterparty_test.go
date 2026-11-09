package stats_test

import (
	"errors"
	"maps"
	"testing"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledgertest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/stats"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

// TestByCounterparty checks the series per counterparty (#170).
func TestByCounterparty(t *testing.T) {
	pool := testdb.New(t)
	user := authtest.NewUser(t, pool, "alice").ID
	e := env{t: t, pool: pool, user: user, l: ledger.New(ledger.Options{})}
	main := ledgertest.Account(t, pool, user, "")
	savings := ledgertest.Account(t, pool, user, "")
	nov, dec1 := at("2026-10-31T23:00:00Z"), at("2026-11-30T23:00:00Z")
	ledgertest.Cycle(t, pool, user, nov, dec1, "active")
	food := ledgertest.Bucket(t, pool, user, main)

	exp := func(when, counterparty, amount string) *ledger.Transaction {
		t.Helper()
		return e.record(ledger.Entry{Type: sqlc.TransactionTypeEXP, At: at(when), Counterparty: counterparty, BankLines: lines(bank{main, "-" + amount})})
	}
	// The same shop, spelt three ways; the newest spelling names it.
	exp("2026-11-01T10:00:00Z", "rema 1000", "100")
	exp("2026-11-03T10:00:00Z", " Rema 1000 ", "200")
	exp("2026-11-02T10:00:00Z", "REMA 1000", "50")
	// Another shop, and one with no counterparty.
	exp("2026-11-02T11:00:00Z", "Rema 1000 Sentrum", "30")
	exp("2026-11-02T12:00:00Z", "", "7")
	// Renamed by a correction: counts under its new name.
	kino := exp("2026-11-01T18:00:00Z", "Cinema", "120")
	e.record(ledger.Entry{
		Type: sqlc.TransactionTypeEXP, At: at("2026-11-01T18:00:00Z"), Correction: sqlc.CorrectionTypeAdjustment, ParentID: kino.Header.ID,
		Counterparty: "Kino",
	})
	// On a bucket, and a transfer out.
	e.record(ledger.Entry{
		Type: sqlc.TransactionTypeEXP, At: at("2026-11-04T10:00:00Z"), Counterparty: "Kiwi",
		BankLines: lines(bank{main, "-80"}), BucketLines: bucketLines(bank{food, "-80"}),
	})
	e.record(ledger.Entry{Type: sqlc.TransactionTypeTRF, At: at("2026-11-04T12:00:00Z"), BankLines: lines(bank{main, "-1000"}, bank{savings, "1000"})})

	series := func(q stats.Query) map[string]string {
		t.Helper()
		q.Metric, q.GroupBy, q.Resolution = stats.Spending, stats.ByCounterparty, stats.Total
		q.From, q.To = nov, dec1
		res, err := stats.Series(t.Context(), pool, user, q)
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]string{}
		var order []string
		for _, l := range res.Series {
			name := l.Counterparty
			switch {
			case l.Transfers:
				name = "(transfers)"
			case l.NoCounterparty:
				name = "(none)"
			}
			out[name] = l.Values[0].StringFixed(2)
			order = append(order, name)
		}
		// Named series by name, then none, then transfers.
		if n := len(order); n >= 2 && order[n-1] == "(transfers)" && order[n-2] != "(none)" {
			t.Errorf("order %v", order)
		}
		return out
	}
	got := series(stats.Query{})
	want := map[string]string{"Rema 1000": "350.00", "Rema 1000 Sentrum": "30.00", "Kino": "120.00", "Kiwi": "80.00", "(none)": "7.00"}
	if !maps.Equal(got, want) {
		t.Errorf("by counterparty = %v, want %v", got, want)
	}
	// One account with transfers: they're one series.
	got = series(stats.Query{AccountIDs: []string{main}, Transfers: true})
	want["(transfers)"] = "1000.00"
	if !maps.Equal(got, want) {
		t.Errorf("with transfers = %v, want %v", got, want)
	}
	// With a bucket filter, only the bucket's part.
	if got := series(stats.Query{BucketIDs: []string{food}}); !maps.Equal(got, map[string]string{"Kiwi": "80.00"}) {
		t.Errorf("food per counterparty = %v", got)
	}
	// Not for balances.
	if _, err := stats.Series(t.Context(), pool, user, stats.Query{
		Metric: stats.Balance, GroupBy: stats.ByCounterparty, Resolution: stats.Total, From: nov, To: dec1,
	}); !errors.Is(err, stats.ErrInvalid) {
		t.Errorf("balance per counterparty: %v", err)
	}
}
