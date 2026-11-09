package transactions_test

import (
	"errors"
	"testing"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledgertest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// TestRenameCounterparty checks renaming an account's interest to its bank (#70).
func TestRenameCounterparty(t *testing.T) {
	e := setup(t)
	other := ledgertest.Account(t, e.pool, e.user, "NOK")
	interest := func(counterparty, account string) transactions.Transaction {
		t.Helper()
		return e.create(t, transactions.New{
			Type: sqlc.TransactionTypeINC, AccountID: account, Amount: dec("12.50"),
			Counterparty: counterparty, Tags: []string{"interest"},
		})
	}
	en := interest("Interest", e.account)
	nb := interest("renter", e.account) // another language, and the case differs
	old := interest("Old Bank", e.account)
	interest("Interest", other)               // another account
	edited := interest("Interest", e.account) // edited by hand later
	e.correct(t, edited.ID, transactions.Changes{Counterparty: ptr("Bonus interest")})
	reversed := interest("Interest", e.account)
	if _, err := e.svc.Reverse(t.Context(), e.user, reversed.ID); err != nil {
		t.Fatal(err)
	}
	// Not interest: no tag, or not an income.
	e.create(t, transactions.New{Type: sqlc.TransactionTypeINC, Amount: dec("1"), Counterparty: "Interest"})
	e.create(t, transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("1"), Counterparty: "Interest", Tags: []string{"interest"}})

	r := transactions.Rename{
		AccountID: e.account, Type: sqlc.TransactionTypeINC, Tag: "interest",
		From: []string{"Interest", "Renter", " old bank "}, To: "DNB",
	}
	if n, err := e.svc.RenameCounterparty(t.Context(), e.user, r); err != nil || n != 3 {
		t.Fatalf("dry run %d %v", n, err)
	}
	if got, _ := e.svc.Get(t.Context(), e.user, en.ID); got.Counterparty != "Interest" {
		t.Errorf("the dry run changed %q", got.Counterparty)
	}

	r.Apply = true
	if n, err := e.svc.RenameCounterparty(t.Context(), e.user, r); err != nil || n != 3 {
		t.Fatalf("apply %d %v", n, err)
	}
	for _, id := range []string{en.ID, nb.ID, old.ID} {
		got, err := e.svc.Get(t.Context(), e.user, id)
		if err != nil || got.Counterparty != "DNB" || !got.Corrected || len(got.History) != 2 ||
			got.History[1].Correction != sqlc.CorrectionTypeAdjustment || len(got.BankLines) != 1 {
			t.Errorf("renamed %+v %v", got, err)
		}
	}
	if got, _ := e.svc.Get(t.Context(), e.user, edited.ID); got.Counterparty != "Bonus interest" {
		t.Errorf("the edited one %q", got.Counterparty)
	}
	if n, err := e.svc.RenameCounterparty(t.Context(), e.user, r); err != nil || n != 0 {
		t.Errorf("again %d %v", n, err)
	}

	// Another user's account matches nothing; bad input is rejected.
	bob := authtest.NewUser(t, e.pool, "bob").ID
	if n, err := e.svc.RenameCounterparty(t.Context(), bob, transactions.Rename{AccountID: other, From: []string{"Interest"}, To: "X", Apply: true}); err != nil || n != 0 {
		t.Errorf("bob %d %v", n, err)
	}
	for _, bad := range []transactions.Rename{
		{AccountID: e.account, To: "DNB"},
		{AccountID: e.account, From: []string{"Interest"}, To: " "},
		{From: []string{"Interest"}, To: "DNB"},
	} {
		if _, err := e.svc.RenameCounterparty(t.Context(), e.user, bad); !errors.Is(err, transactions.ErrInvalid) {
			t.Errorf("%+v: %v", bad, err)
		}
	}
}
