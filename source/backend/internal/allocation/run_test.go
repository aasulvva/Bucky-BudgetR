package allocation_test

import (
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/allocation"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledgertest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/refill"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

type env struct {
	pool     *pgxpool.Pool
	ledger   *ledger.Ledger
	accounts *accounts.Service
	buckets  *buckets.Service
	tx       *transactions.Service
	refills  *refill.Service
	user     string
	account  string
}

func setup(t *testing.T) env {
	t.Helper()
	pool := testdb.New(t)
	l := ledger.New(ledger.Options{AfterRecord: allocation.AfterRecord})
	user := authtest.NewUser(t, pool, "alice").ID
	now := time.Now()
	ledgertest.Cycle(t, pool, user, now.Add(-24*time.Hour), now.Add(30*24*time.Hour), "active")
	refills := refill.NewService(pool, l, refill.Options{})
	e := env{
		pool: pool, ledger: l, user: user, refills: refills,
		accounts: accounts.NewService(pool, l, accounts.Options{}),
		buckets:  buckets.NewService(pool, l, buckets.Options{}),
		tx:       transactions.NewService(pool, l, transactions.Options{Refills: refills}),
	}
	a, err := e.accounts.Create(t.Context(), user, accounts.New{Name: "Main", OpeningBalance: dec("1000")})
	if err != nil {
		t.Fatal(err)
	}
	e.account = a.ID
	return e
}

func (e env) bucket(t *testing.T, name, opening string, priority bool) string {
	t.Helper()
	return e.create(t, buckets.New{Name: name, OpeningFunds: dec(opening), Priority: priority})
}

func (e env) create(t *testing.T, n buckets.New) string {
	t.Helper()
	n.SourceAccountID = e.account
	b, err := e.buckets.Create(t.Context(), e.user, n)
	if err != nil {
		t.Fatal(err)
	}
	return b.ID
}

func (e env) record(t *testing.T, n transactions.New) {
	t.Helper()
	n.AccountID = e.account
	if _, err := e.tx.Create(t.Context(), e.user, n); err != nil {
		t.Fatal(err)
	}
}

// caf returns the stored CAF of the buckets, and the account's unallocated
// money.
func (e env) caf(t *testing.T, ids ...string) ([]string, string) {
	t.Helper()
	var out []string
	for _, id := range ids {
		b, err := e.buckets.Get(t.Context(), e.user, id)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, b.Caf.StringFixed(2))
	}
	a, err := e.accounts.Get(t.Context(), e.user, e.account)
	if err != nil {
		t.Fatal(err)
	}
	return out, a.Unallocated.StringFixed(2)
}

func TestTriggers(t *testing.T) {
	e := setup(t)
	a := e.bucket(t, "A", "300", false)
	b := e.bucket(t, "B", "200", false)
	exp := func(amount string, bucketID string, part string) {
		e.record(t, transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec(amount),
			Buckets: []transactions.BucketAmount{{BucketID: bucketID, Amount: dec(part)}}})
	}
	inc := func(amount string) {
		e.record(t, transactions.New{Type: sqlc.TransactionTypeINC, Amount: dec(amount)})
	}

	steps := []struct {
		name        string
		do          func()
		want        []string
		unallocated string
	}{
		{"enough funds: CAF = TF", func() {}, []string{"300.00", "200.00"}, "500.00"},
		// TF A 200, balance 900: the expense takes A's CAF, B keeps its CAF.
		{"expense from A", func() { exp("100", a, "100") }, []string{"200.00", "200.00"}, "500.00"},
		// 699 not on a bucket, and the balance (200) drops below Σ TF:
		// recalculated by weight. TF A is 199 now, so 200 splits into 99.75
		// and 100.25.
		{"balance drops", func() { exp("700", a, "1") }, []string{"99.75", "100.25"}, "0.00"},
		// Underfunded, but an expense from B takes only B's CAF: A keeps its.
		{"expense from B", func() { exp("50", b, "50") }, []string{"99.75", "50.25"}, "0.00"},
		// Money no bucket owns, however little: 150.50 split by TF 199 and 150.
		{"outside income", func() { inc("0.50") }, []string{"85.82", "64.68"}, "0.00"},
		// B's CAF is spent: 85.82 split by TF 199 and 85.32.
		{"B's CAF spent", func() { exp("64.68", b, "64.68") }, []string{"60.07", "25.75"}, "0.00"},
		// Enough again: CAF = TF.
		{"funds cover TF", func() { inc("1000") }, []string{"199.00", "85.32"}, "801.50"},
	}
	for _, s := range steps {
		s.do()
		got, unallocated := e.caf(t, a, b)
		if got[0] != s.want[0] || got[1] != s.want[1] || unallocated != s.unallocated {
			t.Errorf("%s: CAF %v unallocated %s, want %v and %s", s.name, got, unallocated, s.want, s.unallocated)
		}
	}
}

// TestAdjustments adjusts and moves funds in Bucket setup: a BUA follows the
// usual rules, and a BAT within the account takes covered money along.
func TestAdjustments(t *testing.T) {
	e := setup(t)
	a := e.bucket(t, "A", "800", false)
	b := e.bucket(t, "B", "200", false)
	if got, un := e.caf(t, a, b); got[0] != "800.00" || got[1] != "200.00" || un != "0.00" {
		t.Fatalf("start: CAF %v unallocated %s", got, un)
	}
	// TF 1000 + 200 is more than the balance (1000): it crossed Σ TF, so the
	// account is recalculated by weight.
	if _, err := e.buckets.Adjust(t.Context(), e.user, a, buckets.Adjustment{Mode: buckets.ModeTemporary, TargetFunds: ptr(dec("1000"))}); err != nil {
		t.Fatal(err)
	}
	if got, _ := e.caf(t, a, b); got[0] != "833.33" || got[1] != "166.67" {
		t.Errorf("after the BUA: CAF %v, want 833.33 and 166.67", got)
	}
	// Moving 300 of TF to B takes 300 of A's CAF along; B can take 333.33.
	if _, _, err := e.buckets.Transfer(t.Context(), e.user, a, buckets.Transfer{To: b, Mode: buckets.ModeTemporary, Amount: dec("300")}); err != nil {
		t.Fatal(err)
	}
	if got, un := e.caf(t, a, b); got[0] != "533.33" || got[1] != "466.67" || un != "0.00" {
		t.Errorf("after the BAT: CAF %v unallocated %s, want 533.33, 466.67 and 0", got, un)
	}

	// To another account: B's CAF is limited to its new TF (400), and the
	// other account's bucket follows its own account (no money there).
	other, err := e.accounts.Create(t.Context(), e.user, accounts.New{Name: "Other"})
	if err != nil {
		t.Fatal(err)
	}
	c, err := e.buckets.Create(t.Context(), e.user, buckets.New{Name: "C", SourceAccountID: other.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.buckets.Transfer(t.Context(), e.user, b, buckets.Transfer{To: c.ID, Mode: buckets.ModeTemporary, Amount: dec("100")}); err != nil {
		t.Fatal(err)
	}
	if got, _ := e.caf(t, a, b, c.ID); got[0] != "533.33" || got[1] != "400.00" || got[2] != "0.00" {
		t.Errorf("after the BAT to another account: CAF %v, want 533.33, 400.00 and 0.00", got)
	}
}

// TestRefills refills buckets by hand: CAF only moves when the account
// crosses Σ TF, until the account is reallocated. An income that triggers a
// refill recalculates with the refilled TFs.
func TestRefills(t *testing.T) {
	e := setup(t)
	manual := func(name, ra, opening string) string {
		return e.create(t, buckets.New{Name: name, RefillMode: sqlc.RefillModeManual,
			RefillAmount: dec(ra), OpeningFunds: dec(opening)})
	}
	a := manual("A", "900", "600")
	b := e.bucket(t, "B", "300", false)
	c := manual("C", "200", "0")
	check := func(step string, want []string, unallocated string, ids ...string) {
		t.Helper()
		got, u := e.caf(t, ids...)
		if fmt.Sprint(got) != fmt.Sprint(want) || u != unallocated {
			t.Errorf("%s: CAF %v unallocated %s, want %v and %s", step, got, u, want, unallocated)
		}
	}
	check("start", []string{"600.00", "300.00", "0.00"}, "100.00", a, b, c)

	// TF A 900: Σ TF 1200 is above the balance now, so 1000 is split.
	if err := e.refills.Manual(t.Context(), e.user, a); err != nil {
		t.Fatal(err)
	}
	check("refill crosses Σ TF", []string{"750.00", "250.00", "0.00"}, "0.00", a, b, c)

	// Underfunded already: C's new TF stays unfunded.
	if err := e.refills.Manual(t.Context(), e.user, c); err != nil {
		t.Fatal(err)
	}
	check("refill while underfunded", []string{"750.00", "250.00", "0.00"}, "0.00", a, b, c)

	// By hand: 1000 split by TF 900, 300 and 200.
	acc, err := e.accounts.Reallocate(t.Context(), e.user, e.account)
	if err != nil {
		t.Fatal(err)
	}
	if !acc.Unallocated.IsZero() {
		t.Errorf("reallocated: unallocated %s", acc.Unallocated)
	}
	check("reallocated", []string{"642.86", "214.28", "142.86"}, "0.00", a, b, c)
	if _, err := e.accounts.Reallocate(t.Context(), authtest.NewUser(t, e.pool, "bob").ID, e.account); !errors.Is(err, accounts.ErrNotFound) {
		t.Errorf("another user's account: %v", err)
	}

	// An On income bucket refilled by an income of 100: 1100 split by TF
	// 900, 300, 200 and 100.
	d := e.create(t, buckets.New{Name: "D", RefillMode: sqlc.RefillModeOnIncome, RefillAmount: dec("100")})
	e.record(t, transactions.New{Type: sqlc.TransactionTypeINC, Amount: dec("100"), TriggersRefill: ptr(true)})
	check("income refill", []string{"660.00", "220.00", "146.67", "73.33"}, "0.00", a, b, c, d)
}

func TestSettingsRecalculate(t *testing.T) {
	e := setup(t)
	a := e.bucket(t, "A", "800", false)
	b := e.bucket(t, "B", "800", false)
	// 1000 for 1600 of TF, equal weights.
	if got, _ := e.caf(t, a, b); got[0] != "500.00" || got[1] != "500.00" {
		t.Fatalf("start %v", got)
	}

	// Priority takes effect at once: B is funded first.
	if _, err := e.buckets.Update(t.Context(), e.user, b, buckets.Changes{Priority: ptr(true)}); err != nil {
		t.Fatal(err)
	}
	if got, _ := e.caf(t, a, b); got[0] != "200.00" || got[1] != "800.00" {
		t.Errorf("after priority %v, want 200 and 800", got)
	}

	// A new bucket gets its share straight away.
	if _, err := e.buckets.Update(t.Context(), e.user, b, buckets.Changes{Priority: ptr(false)}); err != nil {
		t.Fatal(err)
	}
	c := e.bucket(t, "C", "400", false)
	if got, _ := e.caf(t, a, b, c); got[0] != "400.00" || got[1] != "400.00" || got[2] != "200.00" {
		t.Errorf("after a new bucket %v, want 400, 400, 200", got)
	}

	// Deleting one frees its CAF for the others (its TF is released too).
	if err := e.buckets.Delete(t.Context(), e.user, c); err != nil {
		t.Fatal(err)
	}
	if got, _ := e.caf(t, a, b); got[0] != "500.00" || got[1] != "500.00" {
		t.Errorf("after delete %v, want 500 and 500", got)
	}

	// Moving B to an empty account leaves it unfunded there and A gets the
	// money.
	empty, err := e.accounts.Create(t.Context(), e.user, accounts.New{Name: "Empty"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.buckets.Update(t.Context(), e.user, b, buckets.Changes{SourceAccountID: &empty.ID}); err != nil {
		t.Fatal(err)
	}
	if got, _ := e.caf(t, a, b); got[0] != "800.00" || got[1] != "0.00" {
		t.Errorf("after moving B %v, want 800 and 0", got)
	}
}

// TestConcurrent records many transactions on the same account and buckets
// at once: the user lock keeps them from deadlocking, and CAF ends up within
// its bounds.
func TestConcurrent(t *testing.T) {
	e := setup(t)
	ids := []string{e.bucket(t, "A", "400", false), e.bucket(t, "B", "400", true)}
	var wg sync.WaitGroup
	errs := make(chan error, 40)
	for i := range 40 {
		wg.Go(func() {
			n := transactions.New{Type: sqlc.TransactionTypeEXP, AccountID: e.account, Amount: dec("30"),
				Buckets: []transactions.BucketAmount{{BucketID: ids[i%2], Amount: dec("5")}}}
			if i%3 == 0 {
				n = transactions.New{Type: sqlc.TransactionTypeINC, AccountID: e.account, Amount: dec("20")}
			}
			if _, err := e.tx.Create(t.Context(), e.user, n); err != nil {
				errs <- err
			}
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent transaction: %v", err)
	}

	a, err := e.accounts.Get(t.Context(), e.user, e.account)
	if err != nil {
		t.Fatal(err)
	}
	sum := decimal.Zero
	for _, id := range ids {
		b, err := e.buckets.Get(t.Context(), e.user, id)
		if err != nil {
			t.Fatal(err)
		}
		if b.Caf.IsNegative() || b.Caf.GreaterThan(decimal.Max(b.TargetFunds, decimal.Zero)) {
			t.Errorf("bucket %s CAF %s outside 0..TF %s", id, b.Caf, b.TargetFunds)
		}
		sum = sum.Add(b.Caf)
	}
	if sum.GreaterThan(decimal.Max(a.Balance, decimal.Zero)) {
		t.Errorf("Σ CAF %s above the balance %s", sum, a.Balance)
	}
}

func ptr[T any](v T) *T { return &v }
