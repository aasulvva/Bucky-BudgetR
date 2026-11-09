package accounts_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
)

// TestBank checks an account's optional bank (#70).
func TestBank(t *testing.T) {
	e := setup(t)
	a, err := e.svc.Create(t.Context(), e.user, accounts.New{Name: "Main", Bank: "  DNB "})
	if err != nil || a.Bank != "DNB" {
		t.Fatalf("created %+v %v", a, err)
	}
	if b := e.create(t, "Buffer", ""); b.Bank != "" {
		t.Errorf("no bank %q", b.Bank)
	}

	bank := "Sbanken"
	got, err := e.svc.Update(t.Context(), e.user, a.ID, accounts.Changes{Bank: &bank})
	if err != nil || got.Bank != "Sbanken" {
		t.Errorf("changed %+v %v", got, err)
	}
	// Other changes keep it, and it's listed.
	name := "Everyday"
	if got, err = e.svc.Update(t.Context(), e.user, a.ID, accounts.Changes{Name: &name}); err != nil || got.Bank != "Sbanken" {
		t.Errorf("renamed %+v %v", got, err)
	}
	list, err := e.svc.List(t.Context(), e.user)
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range list {
		if l.ID == a.ID && l.Bank != "Sbanken" {
			t.Errorf("listed with %q", l.Bank)
		}
	}

	long := strings.Repeat("å", accounts.MaxBank+1)
	if _, err := e.svc.Update(t.Context(), e.user, a.ID, accounts.Changes{Bank: &long}); !errors.Is(err, accounts.ErrInvalid) {
		t.Errorf("101 characters: %v", err)
	}
	if _, err := e.svc.Create(t.Context(), e.user, accounts.New{Name: "Long", Bank: long}); !errors.Is(err, accounts.ErrInvalid) {
		t.Errorf("create with 101 characters: %v", err)
	}
	cleared := " "
	if got, err = e.svc.Update(t.Context(), e.user, a.ID, accounts.Changes{Bank: &cleared}); err != nil || got.Bank != "" {
		t.Errorf("cleared %+v %v", got, err)
	}
}
