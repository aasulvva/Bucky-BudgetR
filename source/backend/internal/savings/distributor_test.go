package savings_test

import (
	"errors"
	"testing"

	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/bsu"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/savings"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// distributorEnv is a user with a main account, two account targets and a
// bucket target on main, each with a rule from 0 with no end.
type distributorEnv struct {
	env
	main, other           string
	buffer, home, holiday string
	holidayBucket         string
}

func setupDistributor(t *testing.T, cycle bool) distributorEnv {
	t.Helper()
	e := distributorEnv{env: setup(t, cycle)}
	ctx := t.Context()
	e.main = e.account(t, "Main", sqlc.AccountTypeUsage, "10000")
	e.other = e.account(t, "Other", sqlc.AccountTypeUsage, "1000")
	buffer := e.account(t, "Buffer", sqlc.AccountTypeSavings, "0")
	home := e.account(t, "Home", sqlc.AccountTypeBsu, "0")
	e.holidayBucket = e.bucket(t, buckets.New{
		Name: "Holiday", SourceAccountID: e.main, RefillMode: sqlc.RefillModeFullyManual,
		CapMode: sqlc.BucketCapModeFixed, CapAmount: dec("3000"),
	})
	for _, x := range []struct {
		id   *string
		n    savings.New
		prio int
	}{
		{&e.buffer, savings.New{AccountID: buffer, Goal: dec("50000")}, 4},
		{&e.home, savings.New{AccountID: home, Goal: dec("200000")}, 6},
		{&e.holiday, savings.New{BucketID: e.holidayBucket, Goal: dec("3000")}, 2},
	} {
		tg, err := e.savings.Create(ctx, e.user, x.n)
		if err != nil {
			t.Fatal(err)
		}
		*x.id = tg.ID
		if _, err := e.savings.CreateRule(ctx, e.user, tg.ID, savings.RuleInput{From: dec("0"), Priority: x.prio}); err != nil {
			t.Fatal(err)
		}
	}
	return e
}

func (e distributorEnv) distributorHeld(t *testing.T, account string) string {
	t.Helper()
	d, err := e.savings.Distributor(t.Context(), e.user)
	if err != nil {
		t.Fatal(err)
	}
	for _, h := range d.Held {
		if h.AccountID == account {
			return h.Amount.StringFixed(2)
		}
	}
	return "0.00"
}

func TestDistributeImmediately(t *testing.T) {
	e := setupDistributor(t, true)
	ctx := t.Context()

	d, split, err := e.savings.AddToDistributor(ctx, e.user, e.main, dec("1200"))
	if err != nil {
		t.Fatal(err)
	}
	if d.HoldMode != sqlc.SavingsHoldModeImmediate || len(split) != 1 {
		t.Fatalf("mode %s, split %v", d.HoldMode, split)
	}
	// 6 + 4 + 2 = 12: Home 600, Buffer 400, Holiday 200 straight into its
	// bucket, which is on Main.
	if got, _ := e.held(t, e.home, e.main); got != "600.00" {
		t.Errorf("held for Home %s", got)
	}
	if got, _ := e.held(t, e.buffer, e.main); got != "400.00" {
		t.Errorf("held for Buffer %s", got)
	}
	if got := e.tf(t, e.holidayBucket); got != "200.00" {
		t.Errorf("Holiday's TF %s", got)
	}
	if got, _ := e.held(t, e.holiday, e.main); got != "0.00" {
		t.Errorf("held for Holiday %s", got)
	}
	if got := e.distributorHeld(t, e.main); got != "0.00" {
		t.Errorf("the distributor holds %s", got)
	}
	svd := e.newest(t, sqlc.TransactionTypeSVD)
	if len(svd.SavingsLines) != 3 || len(svd.BucketLines) != 1 {
		t.Errorf("SVD lines: %d savings, %d bucket", len(svd.SavingsLines), len(svd.BucketLines))
	}
	// 10 000 − 200 in the bucket − 1 000 reserved.
	if _, free, reserved := e.money(t, e.main); free != "8800.00" || reserved != "1000.00" {
		t.Errorf("main: unallocated %s, reserved %s", free, reserved)
	}

	// From another account, the bucket's share is held until it's moved.
	if _, _, err := e.savings.AddToDistributor(ctx, e.user, e.other, dec("120")); err != nil {
		t.Fatal(err)
	}
	if got, _ := e.held(t, e.holiday, e.other); got != "20.00" {
		t.Errorf("held for Holiday on Other %s", got)
	}

	// Reversing the split puts the money back in the distributor.
	if _, err := e.txs.Reverse(ctx, e.user, svd.ID); err != nil {
		t.Fatal(err)
	}
	if got := e.distributorHeld(t, e.main); got != "1200.00" {
		t.Errorf("after the reversal the distributor holds %s", got)
	}
	if got := e.tf(t, e.holidayBucket); got != "0.00" {
		t.Errorf("after the reversal Holiday's TF %s", got)
	}
}

func TestDistributeRefusedReversal(t *testing.T) {
	e := setupDistributor(t, true)
	ctx := t.Context()
	if _, _, err := e.savings.AddToDistributor(ctx, e.user, e.main, dec("1200")); err != nil {
		t.Fatal(err)
	}
	svd := e.newest(t, sqlc.TransactionTypeSVD)
	if _, err := e.savings.Done(ctx, e.user, e.buffer, savings.Done{AccountID: e.main, Amount: dec("400")}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.txs.Reverse(ctx, e.user, svd.ID); !errors.Is(err, transactions.ErrNoLongerHeld) {
		t.Errorf("reversing a split that was moved on: %v", err)
	}
}

func TestDistributeHoldModes(t *testing.T) {
	e := setupDistributor(t, true)
	ctx := t.Context()

	if _, err := e.savings.UpdateDistributor(ctx, e.user, sqlc.SavingsHoldModeMinimum, decimal.NullDecimal{}); !errors.Is(err, savings.ErrInvalid) {
		t.Errorf("minimum without an amount: %v", err)
	}
	if _, err := e.savings.UpdateDistributor(ctx, e.user, sqlc.SavingsHoldModeMinimum, decimal.NewNullDecimal(dec("500"))); err != nil {
		t.Fatal(err)
	}
	// Below the minimum it waits; reaching it splits all of it.
	if _, split, err := e.savings.AddToDistributor(ctx, e.user, e.main, dec("300")); err != nil || len(split) != 0 {
		t.Fatalf("below the minimum: split %v, %v", split, err)
	}
	if got := e.distributorHeld(t, e.main); got != "300.00" {
		t.Errorf("the distributor holds %s", got)
	}
	if _, split, err := e.savings.AddToDistributor(ctx, e.user, e.main, dec("300")); err != nil || len(split) != 1 {
		t.Fatalf("at the minimum: split %v, %v", split, err)
	}
	if got, _ := e.held(t, e.home, e.main); got != "300.00" {
		t.Errorf("held for Home %s", got)
	}

	// Manual: it waits, a preview changes nothing, and Distribute splits.
	if _, err := e.savings.UpdateDistributor(ctx, e.user, sqlc.SavingsHoldModeManual, decimal.NewNullDecimal(dec("500"))); err != nil {
		t.Fatal(err)
	}
	if d, _ := e.savings.Distributor(ctx, e.user); d.MinAmount.Valid {
		t.Errorf("manual keeps the minimum %s", d.MinAmount.Decimal)
	}
	if _, split, err := e.savings.AddToDistributor(ctx, e.user, e.main, dec("1200")); err != nil || len(split) != 0 {
		t.Fatalf("manual: split %v, %v", split, err)
	}
	p, err := e.savings.Preview(ctx, e.user, e.main, dec("1200"))
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Shares) != 3 || !p.Left.IsZero() {
		t.Errorf("preview %+v", p)
	}
	for _, sh := range p.Shares {
		if sh.TargetID == e.holiday && (!sh.IntoBucket || sh.Amount.StringFixed(2) != "200.00") {
			t.Errorf("Holiday's share %+v", sh)
		}
	}
	if got := e.distributorHeld(t, e.main); got != "1200.00" {
		t.Errorf("after the preview the distributor holds %s", got)
	}
	if _, split, err := e.savings.Distribute(ctx, e.user, ""); err != nil || len(split) != 1 {
		t.Fatalf("distribute: split %v, %v", split, err)
	}
	if got := e.distributorHeld(t, e.main); got != "0.00" {
		t.Errorf("after distributing the distributor holds %s", got)
	}

	// Clear: at most what it holds.
	if _, _, err := e.savings.AddToDistributor(ctx, e.user, e.main, dec("100")); err != nil {
		t.Fatal(err)
	}
	var notEnough *savings.NotEnoughHeldError
	if _, err := e.savings.ClearDistributor(ctx, e.user, e.main, dec("100.01")); !errors.As(err, &notEnough) {
		t.Errorf("clearing more than held: %v", err)
	}
	if _, err := e.savings.ClearDistributor(ctx, e.user, e.main, dec("100")); err != nil {
		t.Fatal(err)
	}
	if got := e.distributorHeld(t, e.main); got != "0.00" {
		t.Errorf("after clearing the distributor holds %s", got)
	}
}

func TestDistributeNoTakers(t *testing.T) {
	e := setupDistributor(t, false)
	ctx := t.Context()
	// Without a cycle, the bucket's share is held for it on Main instead.
	if _, _, err := e.savings.AddToDistributor(ctx, e.user, e.main, dec("1200")); err != nil {
		t.Fatal(err)
	}
	if got, _ := e.held(t, e.holiday, e.main); got != "200.00" {
		t.Errorf("held for Holiday without a cycle %s", got)
	}

	// A rule with priority 0 gives nothing; what no target takes stays.
	for _, id := range []string{e.buffer, e.home, e.holiday} {
		rules, err := e.savings.ListRules(ctx, e.user)
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range rules {
			if r.TargetID == id {
				if _, err := e.savings.UpdateRule(ctx, e.user, r.ID, savings.RuleInput{From: r.From, Priority: 0}); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	if _, split, err := e.savings.AddToDistributor(ctx, e.user, e.main, dec("50")); err != nil || len(split) != 0 {
		t.Fatalf("no takers: split %v, %v", split, err)
	}
	if got := e.distributorHeld(t, e.main); got != "50.00" {
		t.Errorf("the distributor holds %s", got)
	}
}

func TestRules(t *testing.T) {
	e := setupDistributor(t, true)
	ctx := t.Context()
	in := func(from, to string, prio int) savings.RuleInput {
		r := savings.RuleInput{From: dec(from), Priority: prio}
		if to != "" {
			r.To = decimal.NewNullDecimal(dec(to))
		}
		return r
	}
	// Buffer has 0 and up: it overlaps anything.
	if _, err := e.savings.CreateRule(ctx, e.user, e.buffer, in("10000", "20000", 1)); !errors.Is(err, savings.ErrRuleOverlap) {
		t.Errorf("an overlapping rule: %v", err)
	}
	rules, err := e.savings.ListRules(ctx, e.user)
	if err != nil {
		t.Fatal(err)
	}
	var bufferRule savings.SavingsRule
	for _, r := range rules {
		if r.TargetID == e.buffer {
			bufferRule = r
		}
	}
	// Ending it at 10 000 makes room for one that touches it.
	if _, err := e.savings.UpdateRule(ctx, e.user, bufferRule.ID, in("0", "10000", 4)); err != nil {
		t.Fatal(err)
	}
	if _, err := e.savings.CreateRule(ctx, e.user, e.buffer, in("10000", "20000", 1)); err != nil {
		t.Errorf("a touching rule: %v", err)
	}
	for _, bad := range []savings.RuleInput{in("-1", "", 1), in("100", "100", 1), in("0", "", 7)} {
		if _, err := e.savings.CreateRule(ctx, e.user, e.home, bad); !errors.Is(err, savings.ErrInvalid) {
			t.Errorf("rule %+v: %v", bad, err)
		}
	}
	for i := range savings.MaxRules - 2 {
		f := decimal.NewFromInt(int64(30000 + i*100))
		if _, err := e.savings.CreateRule(ctx, e.user, e.buffer, savings.RuleInput{
			From: f, To: decimal.NewNullDecimal(f.Add(dec("100"))), Priority: 1,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := e.savings.CreateRule(ctx, e.user, e.buffer, in("90000", "", 1)); !errors.Is(err, savings.ErrTooManyRules) {
		t.Errorf("one rule too many: %v", err)
	}

	// Deleting a target deletes its rules.
	if err := e.savings.Delete(ctx, e.user, e.buffer); err != nil {
		t.Fatal(err)
	}
	rules, err = e.savings.ListRules(ctx, e.user)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rules {
		if r.TargetID == e.buffer {
			t.Fatalf("a deleted target's rule stays: %+v", r)
		}
	}
	if err := e.savings.DeleteRule(ctx, e.user, bufferRule.ID); !errors.Is(err, savings.ErrNotFound) {
		t.Errorf("deleting a deleted target's rule: %v", err)
	}
}

// TestLockedBSUTarget: a BSU target that is locked until its history is set
// up (#214) gets nothing from the distributor or the savings budget, and its
// held funds can't be moved there.
func TestLockedBSUTarget(t *testing.T) {
	e := setupDistributor(t, true)
	ctx := t.Context()
	if _, _, err := e.savings.AddToDistributor(ctx, e.user, e.main, dec("1200")); err != nil {
		t.Fatal(err)
	}
	home, err := e.savings.Get(ctx, e.user, e.home)
	if err != nil {
		t.Fatal(err)
	}
	e.bsuLocked(t, home.AccountID, true)

	if _, err := e.savings.Done(ctx, e.user, e.home, savings.Done{AccountID: e.main, Amount: dec("600")}); !errors.Is(err, bsu.ErrLocked) {
		t.Errorf("Done to a locked BSU: %v", err)
	}
	// Buffer 4 and Holiday 2 share it all.
	if _, _, err := e.savings.AddToDistributor(ctx, e.user, e.main, dec("1200")); err != nil {
		t.Fatal(err)
	}
	if got, _ := e.held(t, e.home, e.main); got != "600.00" {
		t.Errorf("held for Home %s, want 600.00 from before", got)
	}
	if got, _ := e.held(t, e.buffer, e.main); got != "1200.00" {
		t.Errorf("held for Buffer %s", got)
	}
	p, err := e.savings.Preview(ctx, e.user, e.main, dec("600"))
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range p.Shares {
		if s.TargetID == e.home {
			t.Errorf("the preview gives Home %s", s.Amount)
		}
	}

	// A savings budget amount for it goes to the distributor instead.
	entry, err := e.savings.CreateBudget(ctx, e.user, savings.NewBudget{
		AccountID: e.main, TargetID: e.home, Amount: dec("300"), When: sqlc.SavingsBudgetWhenManual,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.savings.SaveNow(ctx, e.user, entry.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := e.held(t, e.home, e.main); got != "600.00" {
		t.Errorf("after the budget, held for Home %s", got)
	}

	// Set up, it takes its share again.
	e.bsuLocked(t, home.AccountID, false)
	if _, err := e.savings.Done(ctx, e.user, e.home, savings.Done{AccountID: e.main, Amount: dec("600")}); err != nil {
		t.Errorf("Done once set up: %v", err)
	}
}

// TestBSUCap caps a BSU target at what it may still be given this year
// (#236): 27 500 a year, less this year's deposits and what's held for it.
func TestBSUCap(t *testing.T) {
	e := setupDistributor(t, true)
	ctx := t.Context()
	home, err := e.savings.Get(ctx, e.user, e.home)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.txs.Create(ctx, e.user, transactions.New{
		Type: sqlc.TransactionTypeINC, AccountID: home.AccountID, Amount: dec("26900"), At: now.Add(-day),
	}); err != nil {
		t.Fatal(err)
	}
	room := func(id string) string {
		t.Helper()
		tg, err := e.savings.Get(ctx, e.user, id)
		if err != nil {
			t.Fatal(err)
		}
		if tg.BSURoom == nil {
			return "nil"
		}
		return tg.BSURoom.StringFixed(2)
	}
	if got := room(e.home); got != "600.00" {
		t.Errorf("Home's room %s, want 600.00", got)
	}
	if got := room(e.buffer); got != "nil" {
		t.Errorf("Buffer's room %s, want none", got)
	}

	// 6 + 4 + 2 would give Home 1 200 of 2 400; it takes 600, and Buffer and
	// Holiday share the rest 4 : 2.
	p, err := e.savings.Preview(ctx, e.user, e.main, dec("2400"))
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range p.Shares {
		if s.TargetID == e.home && s.Amount.StringFixed(2) != "600.00" {
			t.Errorf("the preview gives Home %s", s.Amount)
		}
	}
	if _, _, err := e.savings.AddToDistributor(ctx, e.user, e.main, dec("2400")); err != nil {
		t.Fatal(err)
	}
	if got, _ := e.held(t, e.home, e.main); got != "600.00" {
		t.Errorf("held for Home %s, want 600.00", got)
	}
	if got, _ := e.held(t, e.buffer, e.main); got != "1200.00" {
		t.Errorf("held for Buffer %s, want 1200.00", got)
	}
	// What's held uses the room.
	if got := room(e.home); got != "0.00" {
		t.Errorf("Home's room once held %s, want 0.00", got)
	}

	// A savings budget amount for it goes to the distributor.
	entry, err := e.savings.CreateBudget(ctx, e.user, savings.NewBudget{
		AccountID: e.main, TargetID: e.home, Amount: dec("300"), When: sqlc.SavingsBudgetWhenManual,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.savings.SaveNow(ctx, e.user, entry.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := e.held(t, e.home, e.main); got != "600.00" {
		t.Errorf("after the budget, held for Home %s, want 600.00", got)
	}

	// Done up to the limit is fine; by hand it may hold more, but Done past
	// the limit asks first.
	if _, err := e.savings.Done(ctx, e.user, e.home, savings.Done{AccountID: e.main, Amount: dec("600")}); err != nil {
		t.Fatalf("Done up to the limit: %v", err)
	}
	if _, err := e.savings.Add(ctx, e.user, e.home, e.main, dec("100")); err != nil {
		t.Fatalf("Add past the room: %v", err)
	}
	var over *bsu.OverLimitError
	if _, err := e.savings.Done(ctx, e.user, e.home, savings.Done{AccountID: e.main, Amount: dec("100")}); !errors.As(err, &over) {
		t.Fatalf("Done past the limit: %v", err)
	}
	if _, err := e.savings.Done(ctx, e.user, e.home, savings.Done{AccountID: e.main, Amount: dec("100"), BSUConfirmed: true}); err != nil {
		t.Fatalf("Done past the limit, confirmed: %v", err)
	}

	// Money held on the BSU for another target is a withdrawal when it's done.
	if _, err := e.savings.Add(ctx, e.user, e.buffer, home.AccountID, dec("100")); err != nil {
		t.Fatal(err)
	}
	if _, err := e.savings.Done(ctx, e.user, e.buffer, savings.Done{AccountID: home.AccountID, Amount: dec("100")}); !errors.Is(err, bsu.ErrWithdrawal) {
		t.Errorf("Done out of a BSU: %v", err)
	}

	// A locked BSU has no room: it's paused (#214).
	e.bsuLocked(t, home.AccountID, true)
	if got := room(e.home); got != "nil" {
		t.Errorf("a locked BSU's room %s, want none", got)
	}
}
