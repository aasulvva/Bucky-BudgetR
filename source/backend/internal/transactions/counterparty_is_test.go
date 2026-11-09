package transactions_test

import (
	"slices"
	"testing"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// TestCounterpartyIs checks the exact counterparty filter (#170).
func TestCounterpartyIs(t *testing.T) {
	e := setup(t)
	exp := func(counterparty, description string) string {
		t.Helper()
		return e.create(t, transactions.New{
			Type: sqlc.TransactionTypeEXP, Amount: dec("10"), Counterparty: counterparty, Description: description,
		}).ID
	}
	rema := exp("Rema 1000", "")
	shouty := exp("REMA 1000 ", "")
	exp("Rema 1000 Sentrum", "")
	exp("Kiwi", "Cheaper than Rema 1000")
	renamed := exp("Coop", "")
	e.correct(t, renamed, transactions.Changes{Counterparty: ptr("rema 1000")})
	moved := exp("Rema 1000", "")
	e.correct(t, moved, transactions.Changes{Counterparty: ptr("Bunnpris")})

	page, err := e.svc.List(t.Context(), e.user, transactions.Filter{CounterpartyIs: "  rema 1000"})
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, tx := range page.Items {
		got = append(got, tx.ID)
	}
	// Not Sentrum, Kiwi's description or the one renamed away. They share a
	// time, so the order is by ID: compare as sets.
	want := []string{renamed, shouty, rema}
	slices.Sort(got)
	slices.Sort(want)
	if !equal(got, want) {
		t.Errorf("exact = %v, want %v", got, want)
	}
}
