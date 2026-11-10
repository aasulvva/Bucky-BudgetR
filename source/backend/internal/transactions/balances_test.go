package transactions_test

import (
	"slices"
	"testing"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledgertest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// TestBalancesAfter checks the account's balance after each transaction (#106).
func TestBalancesAfter(t *testing.T) {
	e := setup(t)
	card := ledgertest.Account(t, e.pool, e.user, "NOK")
	at := func(h int) time.Time { return now.Add(-time.Duration(h) * time.Hour) }
	salary := e.create(t, transactions.New{Type: sqlc.TransactionTypeINC, Amount: dec("1000"), At: at(10)})
	food := e.create(t, transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("100"), At: at(9), Counterparty: "Kiwi"})
	// Two at the same time: the order follows the ID, as in the list.
	a := e.create(t, transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("10"), At: at(8)})
	b := e.create(t, transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("20"), At: at(8)})
	first, second := a, b
	if b.ID < a.ID {
		first, second = b, a
	}
	reversed := e.create(t, transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("50"), At: at(7)})
	if _, err := e.svc.Reverse(t.Context(), e.user, reversed.ID); err != nil {
		t.Fatal(err)
	}
	moved := e.create(t, transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("60"), At: at(6)})
	replacement := e.correct(t, moved.ID, transactions.Changes{AccountID: &card})
	transfer := e.create(t, transactions.New{Type: sqlc.TransactionTypeTRF, Amount: dec("200"), At: at(5), ToAccountID: card})
	// A correction made later counts at the original's time.
	more := dec("150")
	e.correct(t, food.ID, transactions.Changes{Amount: &more})

	// balances lists "id balance" for account in f's page, newest first,
	// with "-" for a transaction without one.
	balances := func(f transactions.Filter, account string) []string {
		t.Helper()
		page, err := e.svc.List(t.Context(), e.user, f)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, tx := range page.Items {
			got := "-"
			for _, b := range tx.BalancesAfter {
				if b.AccountID != account {
					t.Errorf("%s has a balance for %s", tx.ID, b.AccountID)
				}
				got = b.Balance.StringFixed(2)
			}
			out = append(out, tx.ID+" "+got)
		}
		return out
	}
	check := func(name string, got, want []string) {
		t.Helper()
		if !slices.Equal(got, want) {
			t.Errorf("%s = %v, want %v", name, got, want)
		}
	}
	main := e.account
	check("main", balances(transactions.Filter{AccountIDs: []string{main}}, main), []string{
		transfer.ID + " 620.00",
		moved.ID + " -",
		reversed.ID + " -",
		second.ID + " 820.00",
		first.ID + " " + map[bool]string{true: "830.00", false: "840.00"}[second.ID == a.ID],
		food.ID + " 850.00",
		salary.ID + " 1000.00",
	})
	check("card", balances(transactions.Filter{AccountIDs: []string{card}}, card), []string{
		transfer.ID + " 140.00",
		replacement.ID + " -60.00",
	})
	// Lines the filter leaves out still count.
	check("incomes", balances(transactions.Filter{AccountIDs: []string{main}, Types: []sqlc.TransactionType{sqlc.TransactionTypeINC}}, main),
		[]string{salary.ID + " 1000.00"})
	check("by counterparty", balances(transactions.Filter{AccountIDs: []string{main}, Counterparty: "kiwi"}, main), []string{food.ID + " 850.00"})
	// A later page follows on from the first.
	page, err := e.svc.List(t.Context(), e.user, transactions.Filter{AccountIDs: []string{main}, Limit: 4})
	if err != nil {
		t.Fatal(err)
	}
	check("page 2", balances(transactions.Filter{AccountIDs: []string{main}, Limit: 4, Cursor: page.Next}, main)[:1],
		[]string{first.ID + " " + map[bool]string{true: "830.00", false: "840.00"}[second.ID == a.ID]})
	// Without an account filter, or with two accounts (#126), there are none.
	for _, f := range []transactions.Filter{{}, {AccountIDs: []string{main, card}}} {
		for _, s := range balances(f, "") {
			if s[len(s)-1] != '-' {
				t.Errorf("%v: %s", f.AccountIDs, s)
			}
		}
	}

	// Get gives every account line.
	got, err := e.svc.Get(t.Context(), e.user, transfer.ID)
	if err != nil {
		t.Fatal(err)
	}
	var both []string
	for _, b := range got.BalancesAfter {
		both = append(both, b.AccountID+" "+b.Balance.StringFixed(2))
	}
	if want := []string{main + " 620.00", card + " 140.00"}; !equal(both, want) {
		t.Errorf("get transfer = %v, want %v", both, want)
	}
	if got, err := e.svc.Get(t.Context(), e.user, reversed.ID); err != nil || len(got.BalancesAfter) != 0 {
		t.Errorf("get reversed = %+v, %v", got.BalancesAfter, err)
	}
}
