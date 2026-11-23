package userdata_test

import (
	"fmt"
	"testing"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cards"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/userdata"
)

// A credit card's bill account follows it into the copy (#260).
func TestCreditCardFollows(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	carol := authtest.NewUser(t, e.pool, "carol")
	main := must[accounts.Account](t)(e.accounts.Create(ctx, carol.ID, accounts.New{Name: "Main"}))
	must[accounts.Account](t)(e.accounts.Create(ctx, carol.ID, accounts.New{
		Name: "Visa", Type: sqlc.AccountTypeCreditCard, OpeningBalance: dec("-1500"),
		Card: &cards.Fields{BillAccountID: main.ID, CreditLimit: dec("20000"), StatementDay: 1, DueDay: 15, MinimumPayment: dec("300")},
	}))
	f, _ := e.file(t, carol.ID)

	dave := authtest.NewUser(t, e.pool, "dave")
	must[userdata.Counts](t)(e.svc.Import(ctx, dave.ID, f))
	list := must[[]accounts.Account](t)(e.accounts.List(ctx, dave.ID))
	ids := map[string]string{}
	var card accounts.Account
	for _, a := range list {
		ids[a.Name] = a.ID
		if a.Name == "Visa" {
			card = a
		}
	}
	if card.Card == nil {
		t.Fatalf("the copy isn't a card: %+v", card)
	}
	got := fmt.Sprintf("%s %s %d %d %s %s", card.Card.BillAccountID, card.Card.CreditLimit, card.Card.StatementDay,
		card.Card.DueDay, card.Card.MinimumPayment, card.Card.Owed)
	if want := fmt.Sprintf("%s 20000 1 15 300 1500", ids["Main"]); got != want || ids["Main"] == main.ID {
		t.Errorf("the copied card %q, want %q", got, want)
	}
}
