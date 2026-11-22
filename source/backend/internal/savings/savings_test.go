package savings_test

import (
	"errors"
	"testing"
	"time"

	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/allocation"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledgertest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/savings"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

var (
	now = time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	day = 24 * time.Hour
)

func dec(s string) decimal.Decimal { return decimal.RequireFromString(s) }

func ptr[T any](v T) *T { return &v }

type env struct {
	user     string
	savings  *savings.Service
	accounts *accounts.Service
	buckets  *buckets.Service
	txs      *transactions.Service
}

// setup wires the services as cmd/server does. With cycle, the user has an
// active cycle around now.
func setup(t *testing.T, cycle bool) env {
	t.Helper()
	pool := testdb.New(t)
	clock := func() time.Time { return now }
	l := ledger.New(ledger.Options{AfterRecord: allocation.AfterRecord})
	sv := savings.NewService(pool, l, savings.Options{Now: clock})
	e := env{
		user:     authtest.NewUser(t, pool, "alice").ID,
		savings:  sv,
		accounts: accounts.NewService(pool, l, accounts.Options{Now: clock, Savings: sv}),
		buckets:  buckets.NewService(pool, l, buckets.Options{Now: clock, ReleaseSavings: sv.ReleaseBucket}),
		txs:      transactions.NewService(pool, l, transactions.Options{Now: clock}),
	}
	if cycle {
		ledgertest.Cycle(t, pool, e.user, now.Add(-day), now.Add(29*day), "active")
	}
	return e
}

func (e env) account(t *testing.T, name string, typ sqlc.AccountType, opening string) string {
	t.Helper()
	a, err := e.accounts.Create(t.Context(), e.user, accounts.New{
		Name: name, Type: typ, OpeningBalance: dec(opening), OpeningAt: now.Add(-2 * day),
	})
	if err != nil {
		t.Fatal(err)
	}
	return a.ID
}

func (e env) bucket(t *testing.T, n buckets.New) string {
	t.Helper()
	b, err := e.buckets.Create(t.Context(), e.user, n)
	if err != nil {
		t.Fatal(err)
	}
	return b.ID
}

func (e env) target(t *testing.T, id string) savings.Target {
	t.Helper()
	got, err := e.savings.Get(t.Context(), e.user, id)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

// held is what's held for the target on the account, and what of it is
// covered.
func (e env) held(t *testing.T, id, account string) (string, string) {
	t.Helper()
	for _, h := range e.target(t, id).Held {
		if h.AccountID == account {
			return h.Amount.StringFixed(2), h.Covered.StringFixed(2)
		}
	}
	return "0.00", "0.00"
}

// money is the account's balance, unallocated and reserved money.
func (e env) money(t *testing.T, id string) (string, string, string) {
	t.Helper()
	a, err := e.accounts.Get(t.Context(), e.user, id)
	if err != nil {
		t.Fatal(err)
	}
	return a.Balance.StringFixed(2), a.Unallocated.StringFixed(2), a.Reserved.StringFixed(2)
}

func (e env) tf(t *testing.T, bucketID string) string {
	t.Helper()
	b, err := e.buckets.Get(t.Context(), e.user, bucketID)
	if err != nil {
		t.Fatal(err)
	}
	return b.TargetFunds.StringFixed(2)
}

// newest returns the transaction of a type recorded last. The clock is
// fixed, so they all have the same time: go by when they were created.
func (e env) newest(t *testing.T, typ sqlc.TransactionType) transactions.Transaction {
	t.Helper()
	page, err := e.txs.List(t.Context(), e.user, transactions.Filter{Types: []sqlc.TransactionType{typ}, Limit: transactions.MaxLimit})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) == 0 {
		t.Fatalf("no %s", typ)
	}
	last := page.Items[0]
	for _, tx := range page.Items[1:] {
		if tx.CreatedAt.After(last.CreatedAt) {
			last = tx
		}
	}
	return last
}

func TestTargets(t *testing.T) {
	e := setup(t, true)
	ctx := t.Context()
	main := e.account(t, "Main", sqlc.AccountTypeUsage, "10000")
	buffer := e.account(t, "Buffer", sqlc.AccountTypeSavings, "0")
	food := e.bucket(t, buckets.New{Name: "Food", SourceAccountID: main, RefillMode: sqlc.RefillModeManual, RefillAmount: dec("4000"), OpeningFunds: dec("4000")})
	holiday := e.bucket(t, buckets.New{
		Name: "Holiday", SourceAccountID: main, RefillMode: sqlc.RefillModeFullyManual,
		CapMode: sqlc.BucketCapModeFixed, CapAmount: dec("3000"),
	})

	for _, tc := range []struct {
		name string
		n    savings.New
		want error
	}{
		{"a usage account", savings.New{AccountID: main, Goal: dec("100")}, savings.ErrWrongAccountType},
		{"a bucket that isn't Fully manual", savings.New{BucketID: food, Goal: dec("100")}, savings.ErrNotFullyManual},
		{"a goal above the capacity", savings.New{BucketID: holiday, Goal: dec("3000.01")}, savings.ErrGoalAboveCapacity},
		{"no goal", savings.New{AccountID: buffer}, savings.ErrInvalid},
		{"both a bucket and an account", savings.New{AccountID: buffer, BucketID: holiday, Goal: dec("1")}, savings.ErrInvalid},
		{"an unknown account", savings.New{AccountID: ledgertest.UnusedAccountID(t, testdb.New(t)), Goal: dec("1")}, savings.ErrNotFound},
	} {
		if _, err := e.savings.Create(ctx, e.user, tc.n); !errors.Is(err, tc.want) {
			t.Errorf("%s: %v, want %v", tc.name, err, tc.want)
		}
	}

	acc, err := e.savings.Create(ctx, e.user, savings.New{AccountID: buffer, Goal: dec("50000"), Note: " For a rainy day \r\n"})
	if err != nil {
		t.Fatal(err)
	}
	if acc.Name != "Buffer" || acc.CustomName != "" || acc.Currency != "NOK" || acc.Note != "For a rainy day" || !acc.Current.IsZero() {
		t.Errorf("account target %+v", acc)
	}
	bkt, err := e.savings.Create(ctx, e.user, savings.New{BucketID: holiday, Goal: dec("2500"), Name: " Summer "})
	if err != nil {
		t.Fatal(err)
	}
	if bkt.Name != "Summer" || bkt.CustomName != "Summer" || bkt.BucketAccountID != main {
		t.Errorf("bucket target %+v", bkt)
	}
	if _, err := e.savings.Create(ctx, e.user, savings.New{AccountID: buffer, Goal: dec("1")}); !errors.Is(err, savings.ErrAlreadyTarget) {
		t.Errorf("the same account again: %v", err)
	}

	// Update: name back to the bucket's, goal within the capacity.
	got, err := e.savings.Update(ctx, e.user, bkt.ID, savings.Changes{Name: ptr(""), Goal: ptr(dec("3000"))})
	if err != nil || got.Name != "Holiday" || got.CustomName != "" || !got.Goal.Equal(dec("3000")) {
		t.Errorf("update: %v %+v", err, got)
	}
	if _, err := e.savings.Update(ctx, e.user, bkt.ID, savings.Changes{Goal: ptr(dec("3001"))}); !errors.Is(err, savings.ErrGoalAboveCapacity) {
		t.Errorf("goal above the capacity: %v", err)
	}
	list, err := e.savings.List(ctx, e.user)
	if err != nil || len(list) != 2 || list[0].ID != acc.ID || list[1].ID != bkt.ID {
		t.Errorf("list: %v %+v", err, list)
	}
}

// TestHeldFunds: Add reserves unallocated money (buckets come first), Done
// moves it, Clear releases it, and reversals put it back.
func TestHeldFunds(t *testing.T) {
	e := setup(t, true)
	ctx := t.Context()
	main := e.account(t, "Main", sqlc.AccountTypeUsage, "10000")
	other := e.account(t, "Other", sqlc.AccountTypeUsage, "1000")
	buffer := e.account(t, "Buffer", sqlc.AccountTypeSavings, "0")
	e.bucket(t, buckets.New{Name: "Food", SourceAccountID: main, RefillMode: sqlc.RefillModeManual, RefillAmount: dec("4000"), OpeningFunds: dec("4000")})
	holiday := e.bucket(t, buckets.New{
		Name: "Holiday", SourceAccountID: main, RefillMode: sqlc.RefillModeFullyManual,
		CapMode: sqlc.BucketCapModeFixed, CapAmount: dec("3000"),
	})
	acc, err := e.savings.Create(ctx, e.user, savings.New{AccountID: buffer, Goal: dec("50000")})
	if err != nil {
		t.Fatal(err)
	}
	bkt, err := e.savings.Create(ctx, e.user, savings.New{BucketID: holiday, Goal: dec("2500")})
	if err != nil {
		t.Fatal(err)
	}

	// Reserving: 10 000 − Food's 4 000 − 2 000 held leaves 4 000 unallocated.
	if _, err := e.savings.Add(ctx, e.user, acc.ID, main, dec("2000")); err != nil {
		t.Fatal(err)
	}
	if bal, free, res := e.money(t, main); bal != "10000.00" || free != "4000.00" || res != "2000.00" {
		t.Errorf("main after add: balance %s unallocated %s reserved %s", bal, free, res)
	}
	svr := e.newest(t, sqlc.TransactionTypeSVR)
	if len(svr.SavingsLines) != 1 || svr.SavingsLines[0].HolderID != acc.ID || svr.SavingsLines[0].Amount.String() != "2000" {
		t.Errorf("SVR lines %+v", svr.SavingsLines)
	}
	var short *savings.NotEnoughUnallocatedError
	if _, err := e.savings.Add(ctx, e.user, acc.ID, main, dec("4000.01")); !errors.As(err, &short) || short.Available.StringFixed(2) != "4000.00" {
		t.Errorf("more than unallocated: %v", err)
	}
	if _, err := e.savings.Add(ctx, e.user, acc.ID, buffer, dec("1")); !errors.Is(err, savings.ErrInvalid) {
		t.Errorf("from the target account itself: %v", err)
	}

	// A bucket target funded from the account gets it straight away (SVB).
	if _, err := e.savings.Add(ctx, e.user, bkt.ID, main, dec("1000")); err != nil {
		t.Fatal(err)
	}
	if e.tf(t, holiday) != "1000.00" {
		t.Errorf("Holiday TF %s, want 1000", e.tf(t, holiday))
	}
	if held, _ := e.held(t, bkt.ID, main); held != "0.00" {
		t.Errorf("held for Holiday on main %s, want none", held)
	}
	if _, free, _ := e.money(t, main); free != "3000.00" {
		t.Errorf("main unallocated %s, want 3000", free)
	}
	if _, err := e.savings.Add(ctx, e.user, bkt.ID, main, dec("2000.01")); !errors.Is(err, savings.ErrAboveCapacity) {
		t.Errorf("above the bucket's capacity: %v", err)
	}
	// From another account it's held until it's moved.
	if _, err := e.savings.Add(ctx, e.user, bkt.ID, other, dec("500")); err != nil {
		t.Fatal(err)
	}

	// Buckets are funded first: an expense the account can't cover leaves
	// the reservation uncovered.
	exp, err := e.txs.Create(ctx, e.user, transactions.New{Type: sqlc.TransactionTypeEXP, AccountID: main, Amount: dec("6000")})
	if err != nil {
		t.Fatal(err)
	}
	if bal, free, _ := e.money(t, main); bal != "4000.00" || free != "0.00" {
		t.Errorf("main after the expense: balance %s unallocated %s", bal, free)
	}
	if held, covered := e.held(t, acc.ID, main); held != "2000.00" || covered != "0.00" {
		t.Errorf("held %s covered %s, want 2000 and 0", held, covered)
	}
	a, _ := e.accounts.Get(ctx, e.user, main)
	if a.ReservedUncovered.StringFixed(2) != "2000.00" {
		t.Errorf("reserved uncovered %s", a.ReservedUncovered)
	}
	if _, err := e.txs.Reverse(ctx, e.user, exp.ID); err != nil {
		t.Fatal(err)
	}
	if held, covered := e.held(t, acc.ID, main); held != "2000.00" || covered != "2000.00" {
		t.Errorf("after reversing: held %s covered %s", held, covered)
	}

	// Done: a transfer to the account target, part of what's held.
	if _, err := e.savings.Done(ctx, e.user, acc.ID, savings.Done{AccountID: main, Amount: dec("1500"), Description: "Monthly"}); err != nil {
		t.Fatal(err)
	}
	if bal, _, _ := e.money(t, buffer); bal != "1500.00" {
		t.Errorf("Buffer balance %s, want 1500", bal)
	}
	if bal, free, res := e.money(t, main); bal != "8500.00" || free != "3000.00" || res != "500.00" {
		t.Errorf("main after Done: balance %s unallocated %s reserved %s", bal, free, res)
	}
	trf := e.newest(t, sqlc.TransactionTypeTRF)
	if len(trf.SavingsLines) != 1 || trf.SavingsLines[0].Amount.String() != "-1500" || trf.Description != "Monthly" {
		t.Errorf("Done transfer %+v", trf)
	}
	var notHeld *savings.NotEnoughHeldError
	if _, err := e.savings.Done(ctx, e.user, acc.ID, savings.Done{AccountID: main, Amount: dec("501")}); !errors.As(err, &notHeld) || notHeld.Held.StringFixed(2) != "500.00" {
		t.Errorf("more than held: %v", err)
	}
	if _, err := e.savings.Done(ctx, e.user, acc.ID, savings.Done{AccountID: main, Amount: dec("100"), At: now.Add(-time.Hour)}); !errors.Is(err, savings.ErrNotEnoughHeld) {
		t.Errorf("dated before it was held: %v", err)
	}
	if _, err := e.savings.Done(ctx, e.user, acc.ID, savings.Done{AccountID: main, Amount: dec("100"), At: now.Add(time.Minute)}); !errors.Is(err, savings.ErrInvalid) {
		t.Errorf("in the future: %v", err)
	}

	// The Done transfer keeps its amount and accounts; its text can change.
	if _, err := e.txs.Correct(ctx, e.user, trf.ID, transactions.Changes{Amount: ptr(dec("1600"))}); !errors.Is(err, transactions.ErrSavingsTransfer) {
		t.Errorf("correct the amount: %v", err)
	}
	if _, err := e.txs.Correct(ctx, e.user, trf.ID, transactions.Changes{ToAccountID: &other}); !errors.Is(err, transactions.ErrSavingsTransfer) {
		t.Errorf("move it: %v", err)
	}
	if _, err := e.txs.Correct(ctx, e.user, trf.ID, transactions.Changes{Description: ptr("Moved to Buffer")}); err != nil {
		t.Errorf("correct the description: %v", err)
	}
	// Reversing it puts the money back on hold.
	if _, err := e.txs.Reverse(ctx, e.user, trf.ID); err != nil {
		t.Fatal(err)
	}
	if held, _ := e.held(t, acc.ID, main); held != "2000.00" {
		t.Errorf("held after reversing Done: %s, want 2000", held)
	}

	// The reservation can't be reversed once part of it has moved on.
	if _, err := e.savings.Done(ctx, e.user, acc.ID, savings.Done{AccountID: main, Amount: dec("1500")}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.txs.Reverse(ctx, e.user, svr.ID); !errors.Is(err, transactions.ErrNoLongerHeld) {
		t.Errorf("reverse the reservation: %v", err)
	}

	// Clear releases it, and reversing the release holds it again.
	if _, err := e.savings.Clear(ctx, e.user, acc.ID, main, dec("600")); !errors.Is(err, savings.ErrNotEnoughHeld) {
		t.Errorf("clear more than held: %v", err)
	}
	if _, err := e.savings.Clear(ctx, e.user, acc.ID, main, dec("500")); err != nil {
		t.Fatal(err)
	}
	if held, _ := e.held(t, acc.ID, main); held != "0.00" {
		t.Errorf("held after clear: %s", held)
	}
	svc := e.newest(t, sqlc.TransactionTypeSVC)
	if _, err := e.txs.Reverse(ctx, e.user, svc.ID); err != nil {
		t.Fatal(err)
	}
	if held, _ := e.held(t, acc.ID, main); held != "500.00" {
		t.Errorf("held after reversing the clear: %s", held)
	}
	if _, err := e.txs.Correct(ctx, e.user, svc.ID, transactions.Changes{Description: ptr("x")}); !errors.Is(err, transactions.ErrNotCorrectable) {
		t.Errorf("correct an SVC: %v", err)
	}

	// Done into a bucket on another account: an SVB with the transfer.
	if _, err := e.savings.Done(ctx, e.user, bkt.ID, savings.Done{AccountID: other, Amount: dec("500")}); err != nil {
		t.Fatal(err)
	}
	if e.tf(t, holiday) != "1500.00" {
		t.Errorf("Holiday TF %s, want 1500", e.tf(t, holiday))
	}
	if bal, _, res := e.money(t, other); bal != "500.00" || res != "0.00" {
		t.Errorf("other after Done: balance %s reserved %s", bal, res)
	}
	svb := e.newest(t, sqlc.TransactionTypeSVB)
	if len(svb.BankLines) != 2 || len(svb.BucketLines) != 1 || len(svb.SavingsLines) != 1 {
		t.Errorf("SVB lines %+v", svb)
	}
	if _, err := e.txs.Reverse(ctx, e.user, svb.ID); err != nil {
		t.Fatal(err)
	}
	if held, _ := e.held(t, bkt.ID, other); held != "500.00" || e.tf(t, holiday) != "1000.00" {
		t.Errorf("after reversing the SVB: held %s TF %s", held, e.tf(t, holiday))
	}
}

// TestRelease: held funds go back to unallocated when their target goes.
func TestRelease(t *testing.T) {
	e := setup(t, true)
	ctx := t.Context()
	main := e.account(t, "Main", sqlc.AccountTypeUsage, "10000")
	other := e.account(t, "Other", sqlc.AccountTypeUsage, "10000")
	buffer := e.account(t, "Buffer", sqlc.AccountTypeSavings, "100")
	fund := e.account(t, "Fund", sqlc.AccountTypeFund, "0")
	fullyManual := func(name string) string {
		return e.bucket(t, buckets.New{Name: name, SourceAccountID: main, RefillMode: sqlc.RefillModeFullyManual})
	}
	target := func(n savings.New) string {
		n.Goal = dec("1000")
		got, err := e.savings.Create(ctx, e.user, n)
		if err != nil {
			t.Fatal(err)
		}
		return got.ID
	}
	add := func(id, account, amount string) {
		if _, err := e.savings.Add(ctx, e.user, id, account, dec(amount)); err != nil {
			t.Fatal(err)
		}
	}
	gone := func(what, id string) {
		t.Helper()
		if _, err := e.savings.Get(ctx, e.user, id); !errors.Is(err, savings.ErrNotFound) {
			t.Errorf("%s: target still there (%v)", what, err)
		}
	}
	reserved := func(account string) string {
		_, _, res := e.money(t, account)
		return res
	}

	// Deleting the target.
	acc := target(savings.New{AccountID: buffer})
	add(acc, main, "100")
	add(acc, other, "200")
	if err := e.savings.Delete(ctx, e.user, acc); err != nil {
		t.Fatal(err)
	}
	gone("deleted", acc)
	if reserved(main) != "0.00" || reserved(other) != "0.00" {
		t.Errorf("after delete: reserved %s and %s", reserved(main), reserved(main))
	}

	// Deleting its bucket, and switching it away from Fully manual.
	trip := fullyManual("Trip")
	tripTarget := target(savings.New{BucketID: trip})
	add(tripTarget, other, "300")
	if err := e.buckets.Delete(ctx, e.user, trip); err != nil {
		t.Fatal(err)
	}
	gone("bucket deleted", tripTarget)
	gifts := fullyManual("Gifts")
	giftsTarget := target(savings.New{BucketID: gifts})
	add(giftsTarget, other, "300")
	if _, err := e.buckets.Update(ctx, e.user, gifts, buckets.Changes{
		RefillMode: ptr(sqlc.RefillModeManual), RefillAmount: ptr(dec("100")), CapMode: ptr(sqlc.BucketCapModeMultiplier), CapMultiplier: ptr(dec("1")),
	}); err != nil {
		t.Fatal(err)
	}
	gone("no longer Fully manual", giftsTarget)
	if reserved(other) != "0.00" {
		t.Errorf("after the buckets: reserved %s", reserved(other))
	}

	// Changing its account's type, and deleting its account.
	fundTarget := target(savings.New{AccountID: fund})
	add(fundTarget, other, "50")
	if _, err := e.accounts.Update(ctx, e.user, fund, accounts.Changes{Type: ptr(sqlc.AccountTypeUsage)}); err != nil {
		t.Fatal(err)
	}
	gone("usage account", fundTarget)
	bufferTarget := target(savings.New{AccountID: buffer})
	add(bufferTarget, other, "50")
	if err := e.accounts.Delete(ctx, e.user, buffer, accounts.Settlement{Remaining: &accounts.Remaining{TransferTo: main}}); err != nil {
		t.Fatal(err)
	}
	gone("account deleted", bufferTarget)
	if reserved(other) != "0.00" {
		t.Errorf("after the accounts: reserved %s", reserved(other))
	}

	// Deleting a source account releases what's held on it, for any target.
	savingsAcc := e.account(t, "Savings", sqlc.AccountTypeSavings, "0")
	kept := target(savings.New{AccountID: savingsAcc})
	add(kept, other, "70")
	add(kept, main, "30")
	if err := e.accounts.Delete(ctx, e.user, other, accounts.Settlement{Remaining: &accounts.Remaining{TransferTo: main}}); err != nil {
		t.Fatal(err)
	}
	got := e.target(t, kept)
	if len(got.Held) != 1 || got.Held[0].AccountID != main || got.HeldTotal().StringFixed(2) != "30.00" {
		t.Errorf("after deleting a source account: %+v", got.Held)
	}
}

// TestWithoutCycle: savings lines don't need an active cycle, but an SVB
// does, and a line gets the cycle its time falls in.
func TestWithoutCycle(t *testing.T) {
	e := setup(t, false)
	ctx := t.Context()
	main := e.account(t, "Main", sqlc.AccountTypeUsage, "1000")
	buffer := e.account(t, "Buffer", sqlc.AccountTypeSavings, "0")
	acc, err := e.savings.Create(ctx, e.user, savings.New{AccountID: buffer, Goal: dec("1000")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.savings.Add(ctx, e.user, acc.ID, main, dec("100")); err != nil {
		t.Fatal(err)
	}
	if _, err := e.savings.Done(ctx, e.user, acc.ID, savings.Done{AccountID: main, Amount: dec("40")}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.savings.Clear(ctx, e.user, acc.ID, main, dec("60")); err != nil {
		t.Fatal(err)
	}

	bucket := e.bucket(t, buckets.New{Name: "Gifts", SourceAccountID: main, RefillMode: sqlc.RefillModeFullyManual})
	bkt, err := e.savings.Create(ctx, e.user, savings.New{BucketID: bucket, Goal: dec("1000")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.savings.Add(ctx, e.user, bkt.ID, main, dec("10")); !errors.Is(err, ledger.ErrNoActiveCycle) {
		t.Errorf("SVB without a cycle: %v", err)
	}
}
