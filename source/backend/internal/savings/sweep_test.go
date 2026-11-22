package savings_test

import (
	"errors"
	"testing"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/savings"
)

// sweep creates a sweep (#235) from account.
func (e overflowEnv) sweep(t *testing.T, account, target, keep string, when sqlc.SavingsBudgetWhen, thisCycle *bool) savings.BudgetEntry {
	t.Helper()
	k := dec(keep)
	b, err := e.savings.CreateBudget(t.Context(), e.user, savings.NewBudget{
		AccountID: account, TargetID: target, Keep: &k, When: when, ThisCycle: thisCycle,
	})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// nextCycle ends the cycle and starts the next one at once, so the Auto
// buckets are refilled and the others wait.
func (e *overflowEnv) nextCycle(t *testing.T) {
	t.Helper()
	ctx := t.Context()
	if _, err := e.cycles.Create(ctx, e.user, now.Add(29*day), now.Add(59*day)); err != nil {
		t.Fatal(err)
	}
	res, err := e.cycles.End(ctx, e.user, e.cycle.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if res.Started == nil {
		t.Fatal("no cycle started")
	}
	e.cycle = *res.Started
}

func TestSweepAfterAllTheRefills(t *testing.T) {
	e := setupOverflow(t)
	ctx := t.Context()
	buffer := e.newTarget(t, "Buffer", "50000")
	e.bucket(t, buckets.New{Name: "Food", SourceAccountID: e.main, RefillAmount: dec("500"), RefillMode: sqlc.RefillModeOnIncome})
	hobby := e.bucket(t, buckets.New{Name: "Hobby", SourceAccountID: e.main, RefillAmount: dec("200"), RefillMode: sqlc.RefillModeManual})
	// Food waits for an income in this cycle, so the sweep waits too, even
	// set up to start now.
	s := e.sweep(t, e.main, buffer, "1000", sqlc.SavingsBudgetWhenAfterRefills, nil)
	if got := e.run(t, s.ID); got != "" {
		t.Errorf("set up mid-cycle, the run is %q", got)
	}
	e.nextCycle(t)
	if got := e.run(t, s.ID); got != "" {
		t.Errorf("before the refills the run is %q", got)
	}
	e.salary(t)
	// Hobby (Manual) isn't refilled yet.
	if got := e.run(t, s.ID); got != "" {
		t.Errorf("before Hobby's refill the run is %q", got)
	}
	if err := e.refills.Manual(ctx, e.user, hobby); err != nil {
		t.Fatal(err)
	}
	// 11000 less Food's 500 and Hobby's 200, less the 1000 to keep.
	if got := e.run(t, s.ID); got != "9300.00/9300.00" {
		t.Errorf("after the refills the run is %q", got)
	}
	if got, _ := e.held(t, buffer, e.main); got != "9300.00" {
		t.Errorf("held for Buffer %s", got)
	}
	if _, free, _ := e.money(t, e.main); free != "1000.00" {
		t.Errorf("unallocated %s", free)
	}
}

func TestSweepUndoneWithTheIncome(t *testing.T) {
	e := setupOverflow(t)
	ctx := t.Context()
	buffer, _, _ := e.splitting(t)
	e.bucket(t, buckets.New{Name: "Food", SourceAccountID: e.main, RefillAmount: dec("500"), RefillMode: sqlc.RefillModeOnIncome})
	s := e.sweep(t, e.main, "", "0", sqlc.SavingsBudgetWhenAfterRefills, ptr(false))
	e.nextCycle(t)
	_, before, _ := e.money(t, e.main)

	income := e.salary(t)
	// To the distributor, which splits it at once.
	if got := e.run(t, s.ID); got != "10500.00/10500.00" {
		t.Errorf("the run is %q", got)
	}
	if _, err := e.txs.Reverse(ctx, e.user, income); err != nil {
		t.Fatal(err)
	}
	if got := e.run(t, s.ID); got != "" {
		t.Errorf("after the undo the run is %q", got)
	}
	if got, _ := e.held(t, buffer, e.main); got != "0.00" {
		t.Errorf("after the undo %s is held for Buffer", got)
	}
	if _, free, _ := e.money(t, e.main); free != before {
		t.Errorf("unallocated %s, was %s", free, before)
	}
	// The next refill sweeps again.
	e.salary(t)
	if got := e.run(t, s.ID); got != "10500.00/10500.00" {
		t.Errorf("after the next income the run is %q", got)
	}
}

func TestSweepWithoutBucketsAtCycleStart(t *testing.T) {
	e := setupOverflow(t)
	side := e.account(t, "Side", sqlc.AccountTypeUsage, "500")
	e.sweep(t, side, "", "0", sqlc.SavingsBudgetWhenAfterRefills, ptr(false))
	e.nextCycle(t)
	if got := e.distributorHeld(t, side); got != "500.00" {
		t.Errorf("the distributor holds %s on Side", got)
	}
}

func TestSweepAtCycleEnd(t *testing.T) {
	e := setupOverflow(t)
	ctx := t.Context()
	tiny := e.newTarget(t, "Tiny", "100")
	fun := e.bucket(t, buckets.New{Name: "Fun", SourceAccountID: e.main, RefillAmount: dec("1000"), RefillMode: sqlc.RefillModeManual})
	if _, err := e.buckets.Adjust(ctx, e.user, fun, buckets.Adjustment{Mode: buckets.ModeTemporary, TargetFunds: ptr(dec("800"))}); err != nil {
		t.Fatal(err)
	}
	s := e.sweep(t, e.main, tiny, "2000", sqlc.SavingsBudgetWhenCycleEnd, nil)
	if got := e.run(t, s.ID); got != "" {
		t.Errorf("before the end the run is %q", got)
	}
	// Ended early, with nothing after: Fun's 800 comes back first, then all
	// but 2000 is swept; Tiny takes 100 to its goal, the distributor the rest.
	if _, err := e.cycles.End(ctx, e.user, e.cycle.ID, false); err != nil {
		t.Fatal(err)
	}
	if got, _ := e.held(t, tiny, e.main); got != "100.00" {
		t.Errorf("held for Tiny %s", got)
	}
	if got := e.distributorHeld(t, e.main); got != "7900.00" {
		t.Errorf("the distributor holds %s", got)
	}
	if _, free, _ := e.money(t, e.main); free != "2000.00" {
		t.Errorf("unallocated %s", free)
	}
}

func TestSweepNothingAboveKeep(t *testing.T) {
	e := setupOverflow(t)
	// Refilled already, so it sweeps now: nothing is above 20000.
	s := e.sweep(t, e.main, "", "20000", sqlc.SavingsBudgetWhenAfterRefills, nil)
	if got := e.run(t, s.ID); got != "0.00/0.00" {
		t.Errorf("the run is %q", got)
	}
	if got := e.distributorHeld(t, e.main); got != "0.00" {
		t.Errorf("the distributor holds %s", got)
	}
	if r := e.entry(t, s.ID).ThisCycle; r == nil || !r.Short().IsZero() || r.At != nil {
		t.Errorf("the run %+v", r)
	}
}

func TestSweepSetUpMidCycleSweepsNow(t *testing.T) {
	e := setupOverflow(t)
	s := e.sweep(t, e.main, "", "4000", sqlc.SavingsBudgetWhenAfterRefills, nil)
	if got := e.run(t, s.ID); got != "6000.00/6000.00" {
		t.Errorf("the run is %q", got)
	}
}

func TestSweepChecks(t *testing.T) {
	e := setupOverflow(t)
	ctx := t.Context()
	s := e.sweep(t, e.main, "", "0", sqlc.SavingsBudgetWhenCycleEnd, nil)
	k := dec("0")
	for name, n := range map[string]savings.NewBudget{
		"a second at cycle end": {AccountID: e.main, Keep: &k, When: sqlc.SavingsBudgetWhenCycleEnd},
	} {
		if _, err := e.savings.CreateBudget(ctx, e.user, n); !errors.Is(err, savings.ErrSweepExists) {
			t.Errorf("%s: %v", name, err)
		}
	}
	for name, n := range map[string]savings.NewBudget{
		"a sweep with an amount": {AccountID: e.main, Amount: dec("5"), When: sqlc.SavingsBudgetWhenAfterRefills},
		"keep below 0":           {AccountID: e.main, Keep: ptr(dec("-1")), When: sqlc.SavingsBudgetWhenAfterRefills},
		"a fixed amount to keep": {AccountID: e.main, Amount: dec("5"), Keep: &k, When: sqlc.SavingsBudgetWhenManual},
	} {
		if _, err := e.savings.CreateBudget(ctx, e.user, n); !errors.Is(err, savings.ErrInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}
	manual := sqlc.SavingsBudgetWhenManual
	if _, err := e.savings.UpdateBudget(ctx, e.user, s.ID, savings.BudgetChanges{When: &manual}); !errors.Is(err, savings.ErrInvalid) {
		t.Errorf("a sweep becoming a fixed amount: %v", err)
	}
	// Another mode is free; the same again isn't.
	after := sqlc.SavingsBudgetWhenAfterRefills
	other := e.sweep(t, e.main, "", "0", after, ptr(false))
	end := sqlc.SavingsBudgetWhenCycleEnd
	if _, err := e.savings.UpdateBudget(ctx, e.user, other.ID, savings.BudgetChanges{When: &end}); !errors.Is(err, savings.ErrSweepExists) {
		t.Errorf("a second at cycle end by update: %v", err)
	}
	// Deleted, its mode is free again.
	if err := e.savings.DeleteBudget(ctx, e.user, s.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.savings.UpdateBudget(ctx, e.user, other.ID, savings.BudgetChanges{When: &end}); err != nil {
		t.Errorf("at cycle end after the delete: %v", err)
	}
}
