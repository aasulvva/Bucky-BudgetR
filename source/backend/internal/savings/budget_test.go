package savings_test

import (
	"errors"
	"testing"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/savings"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// budget creates a savings budget entry from main.
func (e overflowEnv) budget(t *testing.T, target, amount string, when sqlc.SavingsBudgetWhen, thisCycle *bool) savings.BudgetEntry {
	t.Helper()
	b, err := e.savings.CreateBudget(t.Context(), e.user, savings.NewBudget{
		AccountID: e.main, TargetID: target, Amount: dec(amount), When: when, ThisCycle: thisCycle,
	})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// entry returns the entry as ListBudget has it.
func (e overflowEnv) entry(t *testing.T, id string) savings.BudgetEntry {
	t.Helper()
	list, err := e.savings.ListBudget(t.Context(), e.user)
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range list {
		if b.ID == id {
			return b
		}
	}
	t.Fatalf("no entry %s", id)
	return savings.BudgetEntry{}
}

// run is the entry's run this cycle as "wanted/reserved", or "" before it.
func (e overflowEnv) run(t *testing.T, id string) string {
	t.Helper()
	r := e.entry(t, id).ThisCycle
	if r == nil {
		return ""
	}
	return r.Wanted.StringFixed(2) + "/" + r.Reserved.StringFixed(2)
}

func TestBudgetAtCycleStartAfterTheRefills(t *testing.T) {
	e := setupOverflow(t)
	ctx := t.Context()
	e.bucket(t, buckets.New{Name: "Rent", SourceAccountID: e.main, RefillAmount: dec("3000")})
	buffer := e.newTarget(t, "Buffer", "50000")
	b := e.budget(t, buffer, "8000", sqlc.SavingsBudgetWhenCycleStart, ptr(false))
	if got := e.run(t, b.ID); got != "0.00/0.00" {
		t.Errorf("set up to start next cycle, this cycle's run is %q", got)
	}
	if _, err := e.cycles.Create(ctx, e.user, now.Add(29*day), now.Add(59*day)); err != nil {
		t.Fatal(err)
	}
	if _, err := e.cycles.End(ctx, e.user, e.cycle.ID, true); err != nil {
		t.Fatal(err)
	}
	// Rent is refilled first, so 7000 of the 8000 is left to reserve.
	if got, _ := e.held(t, buffer, e.main); got != "7000.00" {
		t.Errorf("held for Buffer %s", got)
	}
	r := e.entry(t, b.ID).ThisCycle
	if r == nil || r.Short().StringFixed(2) != "1000.00" || r.At == nil {
		t.Errorf("the run %+v", r)
	}
}

func TestBudgetOnIncomeOncePerCycle(t *testing.T) {
	e := setupOverflow(t)
	ctx := t.Context()
	b := e.budget(t, "", "300", sqlc.SavingsBudgetWhenOnIncome, nil)
	if got := e.run(t, b.ID); got != "" {
		t.Errorf("before any income the run is %q", got)
	}
	first := e.salary(t)
	e.salary(t)
	if got := e.distributorHeld(t, e.main); got != "300.00" {
		t.Errorf("after two incomes the distributor holds %s", got)
	}

	// Undoing the income that ran it lets the next one run it.
	if _, err := e.txs.Reverse(ctx, e.user, first); err != nil {
		t.Fatal(err)
	}
	if got := e.distributorHeld(t, e.main); got != "0.00" {
		t.Errorf("after the undo the distributor holds %s", got)
	}
	if got := e.run(t, b.ID); got != "" {
		t.Errorf("after the undo the run is %q", got)
	}
	e.salary(t)
	if got := e.run(t, b.ID); got != "300.00/300.00" {
		t.Errorf("the next income's run is %q", got)
	}
}

func TestBudgetUndoneWhenTheIncomeMoves(t *testing.T) {
	e := setupOverflow(t)
	ctx := t.Context()
	other := e.account(t, "Other", sqlc.AccountTypeUsage, "0")
	b := e.budget(t, "", "300", sqlc.SavingsBudgetWhenOnIncome, nil)
	income := e.salary(t)
	if _, err := e.txs.Correct(ctx, e.user, income, transactions.Changes{AccountID: &other}); err != nil {
		t.Fatal(err)
	}
	if got := e.distributorHeld(t, e.main); got != "0.00" {
		t.Errorf("the distributor still holds %s on Main", got)
	}
	if got := e.run(t, b.ID); got != "" {
		t.Errorf("the run is %q", got)
	}
}

func TestBudgetCutAtTheGoalAndSavedOnce(t *testing.T) {
	e := setupOverflow(t)
	ctx := t.Context()
	buffer := e.newTarget(t, "Buffer", "100")
	b := e.budget(t, buffer, "300", sqlc.SavingsBudgetWhenManual, nil)
	if _, err := e.savings.SaveNow(ctx, e.user, b.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := e.held(t, buffer, e.main); got != "100.00" {
		t.Errorf("held for Buffer %s", got)
	}
	if got := e.distributorHeld(t, e.main); got != "200.00" {
		t.Errorf("the distributor holds %s", got)
	}
	if svr := e.newest(t, sqlc.TransactionTypeSVR); len(svr.SavingsLines) != 2 {
		t.Errorf("the SVR has %d savings lines", len(svr.SavingsLines))
	}
	if _, err := e.savings.SaveNow(ctx, e.user, b.ID); !errors.Is(err, savings.ErrAlreadySaved) {
		t.Errorf("saving again: %v", err)
	}
	income := e.budget(t, buffer, "50", sqlc.SavingsBudgetWhenOnIncome, nil)
	if _, err := e.savings.SaveNow(ctx, e.user, income.ID); !errors.Is(err, savings.ErrInvalid) {
		t.Errorf("saving an On income entry by hand: %v", err)
	}
}

func TestBudgetShortOfUnallocated(t *testing.T) {
	e := setupOverflow(t)
	small := e.account(t, "Small", sqlc.AccountTypeUsage, "120")
	b, err := e.savings.CreateBudget(t.Context(), e.user, savings.NewBudget{
		AccountID: small, Amount: dec("500"), When: sqlc.SavingsBudgetWhenManual,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.savings.SaveNow(t.Context(), e.user, b.ID); err != nil {
		t.Fatal(err)
	}
	if got := e.run(t, b.ID); got != "500.00/120.00" {
		t.Errorf("the run is %q", got)
	}
}

func TestBudgetIntoABucketTargetOnTheSameAccount(t *testing.T) {
	e := setupOverflow(t)
	holiday := e.bucket(t, buckets.New{
		Name: "Holiday", SourceAccountID: e.main, RefillMode: sqlc.RefillModeFullyManual,
		CapMode: sqlc.BucketCapModeNone,
	})
	tg, err := e.savings.Create(t.Context(), e.user, savings.New{BucketID: holiday, Goal: dec("3000")})
	if err != nil {
		t.Fatal(err)
	}
	b := e.budget(t, tg.ID, "300", sqlc.SavingsBudgetWhenManual, nil)
	if _, err := e.savings.SaveNow(t.Context(), e.user, b.ID); err != nil {
		t.Fatal(err)
	}
	if got := e.tf(t, holiday); got != "300.00" {
		t.Errorf("Holiday's TF %s", got)
	}
	if got, _ := e.held(t, tg.ID, e.main); got != "0.00" {
		t.Errorf("%s is still held for Holiday", got)
	}
}

func TestBudgetAtCycleStartSetUpMidCycle(t *testing.T) {
	e := setupOverflow(t)
	ctx := t.Context()
	soon := e.budget(t, "", "500", sqlc.SavingsBudgetWhenCycleStart, nil)
	if got := e.run(t, soon.ID); got != "500.00/500.00" {
		t.Errorf("reserved now: the run is %q", got)
	}
	// Switching a manual entry to At cycle start can wait for the next one.
	later := e.budget(t, "", "200", sqlc.SavingsBudgetWhenManual, nil)
	if _, err := e.savings.UpdateBudget(ctx, e.user, later.ID, savings.BudgetChanges{
		When: ptr(sqlc.SavingsBudgetWhenCycleStart), ThisCycle: ptr(false),
	}); err != nil {
		t.Fatal(err)
	}
	if got := e.run(t, later.ID); got != "0.00/0.00" {
		t.Errorf("waiting: the run is %q", got)
	}
	if got := e.distributorHeld(t, e.main); got != "500.00" {
		t.Errorf("the distributor holds %s", got)
	}
}

func TestBudgetChecks(t *testing.T) {
	e := setupOverflow(t)
	ctx := t.Context()
	buffer := e.newTarget(t, "Buffer", "1000")
	euro, err := e.accounts.Create(ctx, e.user, accounts.New{Name: "Euro", Type: sqlc.AccountTypeSavings, Currency: "EUR"})
	if err != nil {
		t.Fatal(err)
	}
	abroad, err := e.savings.Create(ctx, e.user, savings.New{AccountID: euro.ID, Goal: dec("1000")})
	if err != nil {
		t.Fatal(err)
	}
	bufferAccount := e.target(t, buffer).AccountID
	for name, tc := range map[string]struct {
		n    savings.NewBudget
		want error
	}{
		"other currency":  {savings.NewBudget{AccountID: e.main, TargetID: abroad.ID, Amount: dec("1"), When: sqlc.SavingsBudgetWhenManual}, savings.ErrCurrencyMismatch},
		"its own account": {savings.NewBudget{AccountID: bufferAccount, TargetID: buffer, Amount: dec("1"), When: sqlc.SavingsBudgetWhenManual}, savings.ErrInvalid},
		"unknown target":  {savings.NewBudget{AccountID: e.main, TargetID: "9999999999", Amount: dec("1"), When: sqlc.SavingsBudgetWhenManual}, savings.ErrNotFound},
		"unknown account": {savings.NewBudget{AccountID: "9999", Amount: dec("1"), When: sqlc.SavingsBudgetWhenManual}, savings.ErrNotFound},
		"no amount":       {savings.NewBudget{AccountID: e.main, Amount: dec("0"), When: sqlc.SavingsBudgetWhenManual}, savings.ErrInvalid},
		"unknown mode":    {savings.NewBudget{AccountID: e.main, Amount: dec("1"), When: "weekly"}, savings.ErrInvalid},
	} {
		if _, err := e.savings.CreateBudget(ctx, e.user, tc.n); !errors.Is(err, tc.want) {
			t.Errorf("%s: %v, want %v", name, err, tc.want)
		}
	}
}

func TestBudgetStopsWithItsTargetAndGoesWithItsAccount(t *testing.T) {
	e := setupOverflow(t)
	ctx := t.Context()
	buffer := e.newTarget(t, "Buffer", "1000")
	b := e.budget(t, buffer, "100", sqlc.SavingsBudgetWhenOnIncome, nil)
	manual := e.budget(t, buffer, "100", sqlc.SavingsBudgetWhenManual, nil)
	if err := e.savings.Delete(ctx, e.user, buffer); err != nil {
		t.Fatal(err)
	}
	if !e.entry(t, b.ID).Stopped {
		t.Error("the entry isn't stopped")
	}
	e.salary(t)
	if got := e.run(t, b.ID); got != "" {
		t.Errorf("a stopped entry ran: %q", got)
	}
	if _, err := e.savings.SaveNow(ctx, e.user, manual.ID); !errors.Is(err, savings.ErrInvalid) {
		t.Errorf("saving a stopped entry: %v", err)
	}

	spare := e.account(t, "Spare", sqlc.AccountTypeUsage, "0")
	gone, err := e.savings.CreateBudget(ctx, e.user, savings.NewBudget{AccountID: spare, Amount: dec("10"), When: sqlc.SavingsBudgetWhenManual})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.accounts.Delete(ctx, e.user, spare, accounts.Settlement{}); err != nil {
		t.Fatal(err)
	}
	list, err := e.savings.ListBudget(ctx, e.user)
	if err != nil {
		t.Fatal(err)
	}
	for _, x := range list {
		if x.ID == gone.ID {
			t.Error("the deleted account's entry is still listed")
		}
	}
}
