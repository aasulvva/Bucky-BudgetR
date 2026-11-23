package schedules_test

import (
	"testing"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/allocation"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cards"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// A schedule records a purchase past a card's limit without asking, also
// once the card has no default account (#260).
func TestRunCreditCard(t *testing.T) {
	e := setup(t)
	acc := accounts.NewService(e.pool, ledger.New(ledger.Options{AfterRecord: allocation.AfterRecord}), accounts.Options{Now: func() time.Time { return *e.now }})
	card, err := acc.Create(t.Context(), e.user, accounts.New{
		Name: "Visa", Type: sqlc.AccountTypeCreditCard, OpeningBalance: dec("-950"),
		Card: &cards.Fields{DefaultAccountID: e.account, CreditLimit: dec("1000"), StatementDay: 1, DueDay: 15, MinimumPayment: dec("300")},
	})
	if err != nil {
		t.Fatal(err)
	}
	s := e.daily("2026-10-10")
	s.Transaction = transactions.New{Type: sqlc.TransactionTypeEXP, AccountID: card.ID, Amount: dec("100"), Counterparty: "Streaming"}
	sch := e.create(t, s)
	e.run(t, "2026-10-10T12:00:00Z")

	fund := sqlc.AccountTypeFund
	if _, err := acc.Update(t.Context(), e.user, e.account, accounts.Changes{Type: &fund}); err != nil {
		t.Fatal(err)
	}
	e.run(t, "2026-10-11T12:00:00Z")
	if got := e.occurrences(t, sch.ID); !equal(got, []string{"10-10 12:00 applied", "10-11 12:00 applied"}) {
		t.Errorf("occurrences %v", got)
	}
}
