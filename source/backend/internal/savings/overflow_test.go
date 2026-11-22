package savings_test

import (
	"testing"
	"time"

	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/allocation"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cycles"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/refill"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/savings"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// overflowEnv wires the refill routine with savings, as cmd/server does, and
// gives the user an active cycle around now and a main account.
type overflowEnv struct {
	distributorEnv
	cycles *cycles.Service
	cycle  sqlc.Cycle
}

func setupOverflow(t *testing.T) overflowEnv {
	t.Helper()
	ctx := t.Context()
	pool := testdb.New(t)
	clock := func() time.Time { return now }
	l := ledger.New(ledger.Options{AfterRecord: allocation.AfterRecord})
	sv := savings.NewService(pool, l, savings.Options{Now: clock})
	r := refill.NewService(pool, l, refill.Options{Now: clock, Savings: sv})
	e := overflowEnv{
		distributorEnv: distributorEnv{env: env{
			user:     authtest.NewUser(t, pool, "alice").ID,
			savings:  sv,
			accounts: accounts.NewService(pool, l, accounts.Options{Now: clock, Savings: sv}),
			buckets: buckets.NewService(pool, l, buckets.Options{
				Now: clock, OnCreate: r.OnCreate, ReleaseSavings: sv.ReleaseBucket,
			}),
			txs: transactions.NewService(pool, l, transactions.Options{Now: clock, Refills: r}),
		}},
		cycles: cycles.NewService(pool, cycles.Options{Now: clock, OnEnd: r.OnEnd, OnStart: r.OnStart}),
	}
	c, err := e.cycles.Create(ctx, e.user, now.Add(-day), now.Add(29*day))
	if err != nil {
		t.Fatal(err)
	}
	if e.cycle, err = e.cycles.Start(ctx, e.user, c.ID); err != nil {
		t.Fatal(err)
	}
	e.main = e.account(t, "Main", sqlc.AccountTypeUsage, "10000")
	// The distributor waits, so what it gets can be seen.
	if _, err := e.savings.UpdateDistributor(ctx, e.user, sqlc.SavingsHoldModeManual, decimal.NullDecimal{}); err != nil {
		t.Fatal(err)
	}
	return e
}

// food is an On income bucket on main with RA 500 and a fixed BC of 600,
// keeping its funds, with TF 400: a refill takes it to 900, so 300 overflows.
func (e overflowEnv) food(t *testing.T, dest sqlc.OverflowDestination, target string) string {
	t.Helper()
	id := e.bucket(t, buckets.New{
		Name: "Food", SourceAccountID: e.main, RefillAmount: dec("500"), CapMode: sqlc.BucketCapModeFixed,
		CapAmount: dec("600"), KeepFunds: true, RefillMode: sqlc.RefillModeOnIncome,
		OverflowDestination: dest, OverflowTargetID: target,
	})
	if _, err := e.buckets.Adjust(t.Context(), e.user, id, buckets.Adjustment{
		Mode: buckets.ModeTemporary, TargetFunds: ptr(dec("400")),
	}); err != nil {
		t.Fatal(err)
	}
	return id
}

// salary records an income on main that triggers the On income refills.
func (e overflowEnv) salary(t *testing.T) string {
	t.Helper()
	tx, err := e.txs.Create(t.Context(), e.user, transactions.New{
		Type: sqlc.TransactionTypeINC, AccountID: e.main, Counterparty: "Work", Amount: dec("1000"),
		TriggersRefill: ptr(true),
	})
	if err != nil {
		t.Fatal(err)
	}
	return tx.ID
}

func (e overflowEnv) newTarget(t *testing.T, name, goal string) string {
	t.Helper()
	acc := e.account(t, name, sqlc.AccountTypeSavings, "0")
	tg, err := e.savings.Create(t.Context(), e.user, savings.New{AccountID: acc, Goal: dec(goal)})
	if err != nil {
		t.Fatal(err)
	}
	return tg.ID
}

func TestOverflowAtCycleEndToTheDistributor(t *testing.T) {
	e := setupOverflow(t)
	ctx := t.Context()
	small := e.account(t, "Small", sqlc.AccountTypeUsage, "300")
	for _, x := range []struct{ name, account string }{{"Fun", e.main}, {"Short", small}} {
		id := e.bucket(t, buckets.New{
			Name: x.name, SourceAccountID: x.account, RefillAmount: dec("1000"), RefillMode: sqlc.RefillModeManual,
			OverflowDestination: sqlc.OverflowDestinationSavingsDistribution,
		})
		if _, err := e.buckets.Adjust(ctx, e.user, id, buckets.Adjustment{
			Mode: buckets.ModeTemporary, TargetFunds: ptr(dec("800")),
		}); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := e.cycles.End(ctx, e.user, e.cycle.ID, false); err != nil {
		t.Fatal(err)
	}
	// Only what the account covered is real money: all 800 on Main, the
	// 300 Small has.
	if got := e.distributorHeld(t, e.main); got != "800.00" {
		t.Errorf("the distributor holds %s on Main", got)
	}
	if got := e.distributorHeld(t, small); got != "300.00" {
		t.Errorf("the distributor holds %s on Small", got)
	}
	if _, free, reserved := e.money(t, e.main); free != "9200.00" || reserved != "800.00" {
		t.Errorf("main: unallocated %s, reserved %s", free, reserved)
	}
	if ovf := e.newest(t, sqlc.TransactionTypeOVF); len(ovf.SavingsLines) != 1 {
		t.Errorf("an OVF has %d savings lines", len(ovf.SavingsLines))
	}
}

func TestOverflowOnRefillToATarget(t *testing.T) {
	e := setupOverflow(t)
	ctx := t.Context()
	buffer := e.newTarget(t, "Buffer", "50000")
	food := e.food(t, sqlc.OverflowDestinationSavingsTarget, buffer)

	income := e.salary(t)
	if got := e.tf(t, food); got != "600.00" {
		t.Errorf("Food's TF %s", got)
	}
	if got, covered := e.held(t, buffer, e.main); got != "300.00" || covered != "300.00" {
		t.Errorf("held for Buffer %s, covered %s", got, covered)
	}

	// Part of it is moved; undoing the refill releases only the rest.
	if _, err := e.savings.Done(ctx, e.user, buffer, savings.Done{AccountID: e.main, Amount: dec("100")}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.txs.Reverse(ctx, e.user, income); err != nil {
		t.Fatal(err)
	}
	if got := e.tf(t, food); got != "400.00" {
		t.Errorf("after the undo Food's TF %s", got)
	}
	if got, _ := e.held(t, buffer, e.main); got != "0.00" {
		t.Errorf("after the undo %s is held for Buffer", got)
	}
}

func TestOverflowStopsAtTheGoal(t *testing.T) {
	e := setupOverflow(t)
	buffer := e.newTarget(t, "Buffer", "100")
	e.food(t, sqlc.OverflowDestinationSavingsTarget, buffer)

	e.salary(t)
	// 100 fills the goal, and the rest goes to the distributor.
	if got, _ := e.held(t, buffer, e.main); got != "100.00" {
		t.Errorf("held for Buffer %s", got)
	}
	if got := e.distributorHeld(t, e.main); got != "200.00" {
		t.Errorf("the distributor holds %s", got)
	}
	if ovf := e.newest(t, sqlc.TransactionTypeOVF); len(ovf.SavingsLines) != 2 {
		t.Errorf("the OVF has %d savings lines", len(ovf.SavingsLines))
	}

}

func TestOverflowPastTheGoalByRule(t *testing.T) {
	e := setupOverflow(t)
	buffer := e.newTarget(t, "Buffer", "100")
	if _, err := e.savings.CreateRule(t.Context(), e.user, buffer, savings.RuleInput{Priority: 1, PastGoal: true}); err != nil {
		t.Fatal(err)
	}
	e.food(t, sqlc.OverflowDestinationSavingsTarget, buffer)

	e.salary(t)
	if got, _ := e.held(t, buffer, e.main); got != "300.00" {
		t.Errorf("held for Buffer %s", got)
	}
	if got := e.distributorHeld(t, e.main); got != "0.00" {
		t.Errorf("the distributor holds %s", got)
	}
}

func TestOverflowIntoABucketTargetOnTheSameAccount(t *testing.T) {
	e := setupOverflow(t)
	holiday := e.bucket(t, buckets.New{
		Name: "Holiday", SourceAccountID: e.main, RefillMode: sqlc.RefillModeFullyManual,
		CapMode: sqlc.BucketCapModeFixed, CapAmount: dec("3000"),
	})
	tg, err := e.savings.Create(t.Context(), e.user, savings.New{BucketID: holiday, Goal: dec("3000")})
	if err != nil {
		t.Fatal(err)
	}
	e.food(t, sqlc.OverflowDestinationSavingsTarget, tg.ID)

	e.salary(t)
	if got := e.tf(t, holiday); got != "300.00" {
		t.Errorf("Holiday's TF %s", got)
	}
	if got, _ := e.held(t, tg.ID, e.main); got != "0.00" {
		t.Errorf("%s is still held for Holiday", got)
	}
	if svb := e.newest(t, sqlc.TransactionTypeSVB); len(svb.BucketLines) != 1 || len(svb.SavingsLines) != 1 {
		t.Errorf("the SVB has %d bucket and %d savings lines", len(svb.BucketLines), len(svb.SavingsLines))
	}
}

func TestDeletedTargetSendsOverflowToTheDistributor(t *testing.T) {
	e := setupOverflow(t)
	ctx := t.Context()
	buffer := e.newTarget(t, "Buffer", "50000")
	food := e.food(t, sqlc.OverflowDestinationSavingsTarget, buffer)

	if err := e.savings.Delete(ctx, e.user, buffer); err != nil {
		t.Fatal(err)
	}
	b, err := e.buckets.Get(ctx, e.user, food)
	if err != nil {
		t.Fatal(err)
	}
	if b.OverflowDestination != sqlc.OverflowDestinationSavingsDistribution || b.OverflowTargetID.Valid {
		t.Errorf("Food overflows to %s %v", b.OverflowDestination, b.OverflowTargetID)
	}
	e.salary(t)
	if got := e.distributorHeld(t, e.main); got != "300.00" {
		t.Errorf("the distributor holds %s", got)
	}
}
