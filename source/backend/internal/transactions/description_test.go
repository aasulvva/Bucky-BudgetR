package transactions_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledgertest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// TestDescription checks a transaction's optional description (#130).
func TestDescription(t *testing.T) {
	e := setup(t)
	card := ledgertest.Account(t, e.pool, e.user, "NOK")

	// Trimmed, with Windows line breaks made plain; inner lines stay.
	tyres := e.create(t, transactions.New{
		Type: sqlc.TransactionTypeEXP, Amount: dec("4000"), Counterparty: "Dekkmann",
		Description: "  New winter tyres\r\nfitted too  ",
	})
	if tyres.Description != "New winter tyres\nfitted too" {
		t.Errorf("created %q", tyres.Description)
	}
	long := strings.Repeat("é", ledger.MaxDescription)
	if got := e.create(t, transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("1"), Description: long}); got.Description != long {
		t.Errorf("500 characters: %d", len([]rune(got.Description)))
	}
	if _, err := e.svc.Create(t.Context(), e.user, transactions.New{
		Type: sqlc.TransactionTypeEXP, AccountID: e.account, Amount: dec("1"), Description: long + "x",
	}); !errors.Is(err, ledger.ErrInvalid) {
		t.Errorf("501 characters: %v", err)
	}

	// A correction can change only the description; the same one is no change.
	got := e.correct(t, tyres.ID, transactions.Changes{Description: ptr("Winter tyres, fitted")})
	if got.Description != "Winter tyres, fitted" || !got.Corrected || len(got.History) != 2 {
		t.Errorf("corrected %+v", got)
	}
	if _, err := e.svc.Correct(t.Context(), e.user, tyres.ID, transactions.Changes{Description: ptr(" Winter tyres, fitted ")}); !errors.Is(err, transactions.ErrNoChange) {
		t.Errorf("the same description: %v", err)
	}
	// Another change keeps it.
	if got = e.correct(t, tyres.ID, transactions.Changes{Counterparty: ptr("Dekkmann AS")}); got.Description != "Winter tyres, fitted" {
		t.Errorf("kept %q", got.Description)
	}

	// A move brings it to the new account; a reversal keeps it.
	moved := e.correct(t, tyres.ID, transactions.Changes{AccountID: &card})
	if moved.Description != "Winter tyres, fitted" || moved.Replaces != tyres.ID {
		t.Errorf("moved %+v", moved)
	}
	if old, err := e.svc.Get(t.Context(), e.user, tyres.ID); err != nil || old.Description != "Winter tyres, fitted" || !old.Reversed {
		t.Errorf("the moved original %+v %v", old, err)
	}
	reversed, err := e.svc.Reverse(t.Context(), e.user, moved.ID)
	if err != nil || reversed.Description != "Winter tyres, fitted" {
		t.Errorf("reversed %+v %v", reversed, err)
	}
	// "" removes it.
	other := e.create(t, transactions.New{Type: sqlc.TransactionTypeINC, Amount: dec("100"), Description: "Kari's half of dinner"})
	if got = e.correct(t, other.ID, transactions.Changes{Description: ptr("")}); got.Description != "" {
		t.Errorf("removed %q", got.Description)
	}

	// Opening balances and balance adjustments can have one.
	opb, err := e.ledger.Create(t.Context(), e.pool, ledger.Entry{
		UserID: e.user, Type: sqlc.TransactionTypeOPB, At: now.Add(-30 * day),
		BankLines: []ledger.BankLine{{AccountID: card, Amount: dec("5000")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got = e.correct(t, opb.Header.ID, transactions.Changes{Description: ptr("From the old bank")}); got.Description != "From the old bank" {
		t.Errorf("OPB %q", got.Description)
	}

	// The search matches the description, ignoring case, and the counterparty.
	search := func(q string) []string {
		t.Helper()
		page, err := e.svc.List(t.Context(), e.user, transactions.Filter{Counterparty: q})
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, tx := range page.Items {
			out = append(out, tx.ID)
		}
		return out
	}
	if got, want := search("TYRES"), []string{moved.ID, tyres.ID}; !equal(got, want) {
		t.Errorf("by description = %v, want %v", got, want)
	}
	if got, want := search("old bank"), []string{opb.Header.ID}; !equal(got, want) {
		t.Errorf("OPB by description = %v, want %v", got, want)
	}
	if got, want := search("dekkmann"), []string{moved.ID, tyres.ID}; !equal(got, want) {
		t.Errorf("by counterparty = %v, want %v", got, want)
	}
	// Only the effective description counts.
	if got := search("dinner"); len(got) != 0 {
		t.Errorf("a removed description matched %v", got)
	}
}
