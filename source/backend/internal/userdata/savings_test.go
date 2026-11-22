package userdata_test

import (
	"strings"
	"testing"

	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/allocation"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/savings"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/userdata"
)

// TestExportImportSavings: savings targets and their lines (#231) round-trip,
// and follow the new IDs into another user's copy.
func TestExportImportSavings(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	l := ledger.New(ledger.Options{AfterRecord: allocation.AfterRecord})
	sv := savings.NewService(e.pool, l, savings.Options{Now: clock})
	alice := authtest.NewUser(t, e.pool, "alice")
	main := must[accounts.Account](t)(e.accounts.Create(ctx, alice.ID, accounts.New{Name: "Main", OpeningBalance: dec("1000")}))
	buffer := must[accounts.Account](t)(e.accounts.Create(ctx, alice.ID, accounts.New{Name: "Buffer", Type: sqlc.AccountTypeSavings}))
	target := must[savings.Target](t)(sv.Create(ctx, alice.ID, savings.New{AccountID: buffer.ID, Goal: dec("5000"), Note: "Rainy day"}))
	must[savings.Target](t)(sv.Add(ctx, alice.ID, target.ID, main.ID, dec("100")))
	must[savings.Target](t)(sv.Done(ctx, alice.ID, target.ID, savings.Done{AccountID: main.ID, Amount: dec("40")}))

	f, _ := e.file(t, alice.ID)
	if n, m := len(f.Data.Tables["savings_holders"]), len(f.Data.Tables["savings_transactions"]); n != 1 || m != 2 {
		t.Fatalf("exported %d holders and %d savings lines, want 1 and 2", n, m)
	}
	must[userdata.Counts](t)(e.svc.Import(ctx, alice.ID, f))
	again, _ := e.file(t, alice.ID)
	if got, want := asJSON(t, again.Data), asJSON(t, f.Data); got != want {
		t.Errorf("after the import:\n%s\nwant\n%s", got, want)
	}

	bob := authtest.NewUser(t, e.pool, "bob")
	must[userdata.Counts](t)(e.svc.Import(ctx, bob.ID, f))
	list := must[[]savings.Target](t)(sv.List(ctx, bob.ID))
	if len(list) != 1 || list[0].ID == target.ID || !strings.HasPrefix(list[0].ID, bob.ID) || list[0].Note != "Rainy day" {
		t.Fatalf("bob's targets %+v", list)
	}
	got := list[0]
	if got.AccountID == buffer.ID || got.HeldTotal().StringFixed(2) != "60.00" || got.Current.StringFixed(2) != "40.00" {
		t.Errorf("bob's target: account %s held %s current %s", got.AccountID, got.HeldTotal(), got.Current)
	}
	for _, line := range must[userdata.File](t)(e.svc.Export(ctx, bob.ID)).Data.Tables["savings_transactions"] {
		if !strings.HasPrefix(line["id"].(string), got.ID) || line["holder_id"] != got.ID {
			t.Errorf("bob's savings line %v", line)
		}
	}
}

// TestExportImportDistributor: the distributor, its rules and its SVD
// (#232) round-trip, and a copy's rules follow their target's new ID.
func TestExportImportDistributor(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	l := ledger.New(ledger.Options{AfterRecord: allocation.AfterRecord})
	sv := savings.NewService(e.pool, l, savings.Options{Now: clock})
	alice := authtest.NewUser(t, e.pool, "alice")
	main := must[accounts.Account](t)(e.accounts.Create(ctx, alice.ID, accounts.New{Name: "Main", OpeningBalance: dec("1000")}))
	buffer := must[accounts.Account](t)(e.accounts.Create(ctx, alice.ID, accounts.New{Name: "Buffer", Type: sqlc.AccountTypeSavings}))
	target := must[savings.Target](t)(sv.Create(ctx, alice.ID, savings.New{AccountID: buffer.ID, Goal: dec("5000")}))
	for _, r := range []savings.RuleInput{
		{From: dec("0"), To: decimal.NewNullDecimal(dec("1000")), Priority: 3},
		{From: dec("1000"), Priority: 1, PastGoal: true},
	} {
		must[savings.SavingsRule](t)(sv.CreateRule(ctx, alice.ID, target.ID, r))
	}
	if _, split, err := sv.AddToDistributor(ctx, alice.ID, main.ID, dec("100")); err != nil || len(split) != 1 {
		t.Fatalf("add to the distributor: split %v, %v", split, err)
	}

	f, _ := e.file(t, alice.ID)
	if n, m := len(f.Data.Tables["savings_holders"]), len(f.Data.Tables["savings_rules"]); n != 2 || m != 2 {
		t.Fatalf("exported %d holders and %d rules, want 2 and 2", n, m)
	}
	must[userdata.Counts](t)(e.svc.Import(ctx, alice.ID, f))
	again, _ := e.file(t, alice.ID)
	if got, want := asJSON(t, again.Data), asJSON(t, f.Data); got != want {
		t.Errorf("after the import:\n%s\nwant\n%s", got, want)
	}

	bob := authtest.NewUser(t, e.pool, "bob")
	must[userdata.Counts](t)(e.svc.Import(ctx, bob.ID, f))
	list := must[[]savings.Target](t)(sv.List(ctx, bob.ID))
	if len(list) != 1 || list[0].HeldTotal().StringFixed(2) != "100.00" {
		t.Fatalf("bob's targets %+v", list)
	}
	rules := must[[]savings.SavingsRule](t)(sv.ListRules(ctx, bob.ID))
	if len(rules) != 2 {
		t.Fatalf("bob's rules %+v", rules)
	}
	for _, r := range rules {
		if r.TargetID != list[0].ID || !strings.HasPrefix(r.ID, list[0].ID) {
			t.Errorf("bob's rule %+v, target %s", r, list[0].ID)
		}
	}
	if d := must[savings.Distributor](t)(sv.Distributor(ctx, bob.ID)); d.ID == "" || !strings.HasPrefix(d.ID, bob.ID) || len(d.Held) != 0 {
		t.Errorf("bob's distributor %+v", d)
	}
}
