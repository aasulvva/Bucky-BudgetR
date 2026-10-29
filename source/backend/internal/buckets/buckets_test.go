package buckets_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/balance"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledgertest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

func dec(s string) decimal.Decimal { return decimal.RequireFromString(s) }

func ptr[T any](v T) *T { return &v }

var (
	now = time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)
	day = 24 * time.Hour
)

type env struct {
	pool    *pgxpool.Pool
	svc     *buckets.Service
	ledger  *ledger.Ledger
	user    string
	account string
}

func setup(t *testing.T) env {
	t.Helper()
	pool := testdb.New(t)
	l := ledger.New(ledger.Options{})
	user := authtest.NewUser(t, pool, "alice").ID
	return env{
		pool:    pool,
		svc:     buckets.NewService(pool, l, buckets.Options{Now: func() time.Time { return now }}),
		ledger:  l,
		user:    user,
		account: ledgertest.Account(t, pool, user, "NOK"),
	}
}

// startCycle gives the user an active cycle around now.
func (e env) startCycle(t *testing.T) {
	t.Helper()
	ledgertest.Cycle(t, e.pool, e.user, now.Add(-day), now.Add(29*day), "active")
}

func (e env) create(t *testing.T, n buckets.New) buckets.Bucket {
	t.Helper()
	if n.SourceAccountID == "" {
		n.SourceAccountID = e.account
	}
	b, err := e.svc.Create(t.Context(), e.user, n)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func (e env) get(t *testing.T, id string) buckets.Bucket {
	t.Helper()
	b, err := e.svc.Get(t.Context(), e.user, id)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// count returns how many transactions of a type the user has.
func (e env) count(t *testing.T, typ sqlc.TransactionType) int {
	t.Helper()
	var n int
	err := e.pool.QueryRow(context.Background(),
		"SELECT count(*) FROM transaction_headers WHERE user_id = $1 AND transaction_type = $2", e.user, typ).Scan(&n)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestCreate(t *testing.T) {
	e := setup(t)
	b := e.create(t, buckets.New{Name: "  Groceries ", RefillAmount: dec("4000")})
	if b.Name != "Groceries" || b.Currency != "NOK" || b.SourceAccountID != e.account {
		t.Errorf("bucket %+v", b)
	}
	if b.CapMode != sqlc.BucketCapModeMultiplier || !b.CapMultiplier.Decimal.Equal(dec("1")) || b.CapAmount.Valid {
		t.Errorf("cap %s %v %v, want multiplier 1", b.CapMode, b.CapMultiplier, b.CapAmount)
	}
	if b.RefillMode != sqlc.RefillModeAuto || b.OverflowDestination != sqlc.OverflowDestinationUnallocated ||
		b.Importance != buckets.DefaultImportance || b.KeepFunds || b.Priority {
		t.Errorf("defaults %+v", b)
	}
	if !b.Capacity.Decimal.Equal(dec("4000")) || !b.TargetFunds.IsZero() || !b.Caf.IsZero() {
		t.Errorf("BC %s TF %s CAF %s", b.Capacity.Decimal, b.TargetFunds, b.Caf)
	}
	// No opening funds: nothing recorded, and no cycle needed.
	if n := e.count(t, sqlc.TransactionTypeOPF); n != 0 {
		t.Errorf("%d OPF transactions, want 0", n)
	}

	got := e.get(t, b.ID)
	if got.Name != b.Name || !got.Capacity.Decimal.Equal(b.Capacity.Decimal) {
		t.Errorf("get %+v", got)
	}

	if _, err := e.svc.Create(t.Context(), e.user, buckets.New{Name: "GROCERIES", SourceAccountID: e.account}); !errors.Is(err, buckets.ErrNameTaken) {
		t.Errorf("duplicate name: %v", err)
	}

	unknown := ledgertest.UnusedAccountID(t, e.pool)
	for name, n := range map[string]buckets.New{
		"empty name":         {Name: "  "},
		"long name":          {Name: strings.Repeat("x", 101)},
		"negative RA":        {RefillAmount: dec("-1")},
		"3 decimals":         {RefillAmount: dec("1.005")},
		"multiplier below 1": {CapMultiplier: dec("0.5")},
		"multiplier decimal": {CapMultiplier: dec("1.555")},
		"bad cap mode":       {CapMode: "double"},
		"bad refill mode":    {RefillMode: "weekly"},
		"savings overflow":   {OverflowDestination: sqlc.OverflowDestinationSavingsDistribution},
		"importance 11":      {Importance: 11},
		"negative opening":   {OpeningFunds: dec("-5")},
		"unknown account":    {SourceAccountID: unknown},
	} {
		if n.Name == "" {
			n.Name = "Bucket " + name
		}
		if n.SourceAccountID == "" {
			n.SourceAccountID = e.account
		}
		if _, err := e.svc.Create(t.Context(), e.user, n); !errors.Is(err, buckets.ErrInvalid) {
			t.Errorf("%s: %v, want ErrInvalid", name, err)
		}
	}
}

func TestCreateSource(t *testing.T) {
	e := setup(t)
	bob := authtest.NewUser(t, e.pool, "bob").ID
	bobs := ledgertest.Account(t, e.pool, bob, "NOK")
	deleted := ledgertest.Account(t, e.pool, e.user, "NOK")
	ledgertest.Delete(t, e.pool, "bank_accounts", deleted)
	for name, acc := range map[string]string{"another user's": bobs, "deleted": deleted} {
		if _, err := e.svc.Create(t.Context(), e.user, buckets.New{Name: name, SourceAccountID: acc}); !errors.Is(err, buckets.ErrInvalid) {
			t.Errorf("%s account: %v, want ErrInvalid", name, err)
		}
	}

	eur := ledgertest.Account(t, e.pool, e.user, "EUR")
	if b := e.create(t, buckets.New{Name: "Travel", SourceAccountID: eur}); b.Currency != "EUR" {
		t.Errorf("currency %s, want the account's EUR", b.Currency)
	}
}

func TestCapacity(t *testing.T) {
	e := setup(t)
	b := e.create(t, buckets.New{Name: "Fuel", RefillAmount: dec("1000.05"), CapMultiplier: dec("1.5")})
	if !b.Capacity.Decimal.Equal(dec("1500.08")) {
		t.Errorf("BC %s, want 1000.05 × 1.5 rounded = 1500.08", b.Capacity.Decimal)
	}
	b = e.create(t, buckets.New{Name: "Rent", RefillAmount: dec("9000"), CapMode: sqlc.BucketCapModeFixed, CapAmount: dec("8000")})
	if !b.CapAmount.Decimal.Equal(dec("9000")) || !b.Capacity.Decimal.Equal(dec("9000")) || b.CapMultiplier.Valid {
		t.Errorf("fixed BC %v / %s, want raised to RA 9000", b.CapAmount, b.Capacity.Decimal)
	}
	b = e.create(t, buckets.New{Name: "Gifts", RefillAmount: dec("500"), CapMode: sqlc.BucketCapModeFixed, CapAmount: dec("2000")})
	if !b.Capacity.Decimal.Equal(dec("2000")) {
		t.Errorf("fixed BC %s, want 2000", b.Capacity.Decimal)
	}
}

func TestDefaultRefillMode(t *testing.T) {
	e := setup(t)
	if _, err := e.pool.Exec(t.Context(), `UPDATE users SET preferences = '{"default_refill_mode": "manual"}' WHERE id = $1`, e.user); err != nil {
		t.Fatal(err)
	}
	if b := e.create(t, buckets.New{Name: "Fun"}); b.RefillMode != sqlc.RefillModeManual {
		t.Errorf("refill mode %s, want the preference manual", b.RefillMode)
	}
	if b := e.create(t, buckets.New{Name: "Bills", RefillMode: sqlc.RefillModeOnIncome}); b.RefillMode != sqlc.RefillModeOnIncome {
		t.Errorf("refill mode %s, want the given on_income", b.RefillMode)
	}
}

func TestNegativeTF(t *testing.T) {
	e := setup(t)
	if b := e.create(t, buckets.New{Name: "Fun", KeepFunds: true}); b.NegativeTf != sqlc.NegativeTfDebt {
		t.Errorf("negative TF %s without a preference, want debt", b.NegativeTf)
	}
	if _, err := e.pool.Exec(t.Context(), `UPDATE users SET preferences = '{"default_negative_tf": "clear"}' WHERE id = $1`, e.user); err != nil {
		t.Fatal(err)
	}
	b := e.create(t, buckets.New{Name: "Trips", KeepFunds: true})
	if b.NegativeTf != sqlc.NegativeTfClear {
		t.Errorf("negative TF %s, want the preference clear", b.NegativeTf)
	}
	if b := e.create(t, buckets.New{Name: "Gifts", NegativeTF: sqlc.NegativeTfDebt}); b.NegativeTf != sqlc.NegativeTfDebt {
		t.Errorf("negative TF %s, want the given debt", b.NegativeTf)
	}

	got, err := e.svc.Update(t.Context(), e.user, b.ID, buckets.Changes{NegativeTF: ptr(sqlc.NegativeTfDebt)})
	if err != nil {
		t.Fatal(err)
	}
	if got.NegativeTf != sqlc.NegativeTfDebt {
		t.Errorf("updated negative TF %s, want debt", got.NegativeTf)
	}
	if _, err := e.svc.Update(t.Context(), e.user, b.ID, buckets.Changes{NegativeTF: ptr(sqlc.NegativeTf("forgive"))}); !errors.Is(err, buckets.ErrInvalid) {
		t.Errorf("invalid negative TF: %v", err)
	}
}

func TestOpeningFunds(t *testing.T) {
	e := setup(t)
	n := buckets.New{Name: "Groceries", SourceAccountID: e.account, OpeningFunds: dec("250")}
	if _, err := e.svc.Create(t.Context(), e.user, n); !errors.Is(err, ledger.ErrNoActiveCycle) {
		t.Fatalf("no active cycle: %v", err)
	}
	if list, _ := e.svc.List(t.Context(), e.user); len(list) != 0 {
		t.Errorf("%d buckets after a refused create, want 0", len(list))
	}

	// An overdue cycle refuses bucket lines too.
	overdue := ledgertest.Cycle(t, e.pool, e.user, now.Add(-30*day), now.Add(-day), "active")
	if _, err := e.svc.Create(t.Context(), e.user, n); !errors.Is(err, ledger.ErrOutsideCycle) {
		t.Fatalf("overdue cycle: %v", err)
	}
	if _, err := e.pool.Exec(t.Context(), "UPDATE cycles SET state = 'finished' WHERE id = $1", overdue); err != nil {
		t.Fatal(err)
	}

	e.startCycle(t)
	b := e.create(t, n)
	if !b.TargetFunds.Equal(dec("250")) || !e.get(t, b.ID).TargetFunds.Equal(dec("250")) {
		t.Errorf("TF %s, want 250", b.TargetFunds)
	}
	if c := e.count(t, sqlc.TransactionTypeOPF); c != 1 {
		t.Errorf("%d OPF transactions, want 1", c)
	}
}

func TestUpdate(t *testing.T) {
	e := setup(t)
	b := e.create(t, buckets.New{Name: "Fuel", RefillAmount: dec("1000"), CapMultiplier: dec("2")})
	if _, err := e.pool.Exec(t.Context(), "UPDATE buckets SET caf = 700 WHERE id = $1", b.ID); err != nil {
		t.Fatal(err)
	}

	// These settings don't change how the money is split: CAF stays.
	got, err := e.svc.Update(t.Context(), e.user, b.ID, buckets.Changes{
		Name: ptr("Car"), RefillAmount: ptr(dec("1200")), KeepFunds: ptr(true), RefillMode: ptr(sqlc.RefillModeManual),
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "Car" || !got.Capacity.Decimal.Equal(dec("2400")) || !got.KeepFunds || got.RefillMode != sqlc.RefillModeManual ||
		!got.Caf.Equal(dec("700")) {
		t.Errorf("updated %+v", got)
	}
	// Priority and importance recalculate the account at once (TF is 0
	// here, so CAF is too).
	got, err = e.svc.Update(t.Context(), e.user, b.ID, buckets.Changes{Priority: ptr(true), Importance: ptr(8)})
	if err != nil {
		t.Fatal(err)
	}
	if !got.Priority || got.Importance != 8 || !got.Caf.IsZero() {
		t.Errorf("priority and importance %+v", got)
	}

	// Switching to fixed without an amount: BC = RA.
	got, err = e.svc.Update(t.Context(), e.user, b.ID, buckets.Changes{CapMode: ptr(sqlc.BucketCapModeFixed)})
	if err != nil {
		t.Fatal(err)
	}
	if got.CapMultiplier.Valid || !got.Capacity.Decimal.Equal(dec("1200")) {
		t.Errorf("switched to fixed: %v / %s, want BC = RA", got.CapMultiplier, got.Capacity.Decimal)
	}
	// A fixed amount below RA is raised to it.
	if got, err = e.svc.Update(t.Context(), e.user, b.ID, buckets.Changes{CapAmount: ptr(dec("100"))}); err != nil || !got.Capacity.Decimal.Equal(dec("1200")) {
		t.Errorf("fixed below RA: %v, BC %s", err, got.Capacity.Decimal)
	}
	// Raising RA above the fixed amount raises BC.
	if got, err = e.svc.Update(t.Context(), e.user, b.ID, buckets.Changes{RefillAmount: ptr(dec("1500"))}); err != nil || !got.Capacity.Decimal.Equal(dec("1500")) {
		t.Errorf("RA above fixed BC: %v, BC %s", err, got.Capacity.Decimal)
	}
	if _, err := e.svc.Update(t.Context(), e.user, b.ID, buckets.Changes{CapMultiplier: ptr(dec("2"))}); !errors.Is(err, buckets.ErrInvalid) {
		t.Errorf("multiplier in fixed mode: %v", err)
	}
	if _, err := e.svc.Update(t.Context(), e.user, b.ID, buckets.Changes{OverflowDestination: ptr(sqlc.OverflowDestinationSavingsTarget)}); !errors.Is(err, buckets.ErrInvalid) {
		t.Errorf("savings target overflow: %v", err)
	}

	e.create(t, buckets.New{Name: "Rent"})
	if _, err := e.svc.Update(t.Context(), e.user, b.ID, buckets.Changes{Name: ptr("rent")}); !errors.Is(err, buckets.ErrNameTaken) {
		t.Errorf("rename to a taken name: %v", err)
	}
	if _, err := e.svc.Update(t.Context(), e.user, "1234567890", buckets.Changes{Name: ptr("X")}); !errors.Is(err, buckets.ErrNotFound) {
		t.Errorf("unknown bucket: %v", err)
	}
}

func TestSetRefillAmounts(t *testing.T) {
	e := setup(t)
	e.startCycle(t)
	food := e.create(t, buckets.New{Name: "Food", RefillAmount: dec("1000"), CapMultiplier: dec("2"), OpeningFunds: dec("400")})
	rent := e.create(t, buckets.New{Name: "Rent", RefillAmount: dec("500"), CapMode: sqlc.BucketCapModeFixed, CapAmount: dec("600")})
	txs := e.count(t, sqlc.TransactionTypeBUA)

	got, err := e.svc.SetRefillAmounts(t.Context(), e.user, []buckets.RefillAmount{
		{BucketID: rent.ID, Amount: dec("800")},
		{BucketID: food.ID, Amount: dec("1200")},
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].ID != rent.ID || got[1].ID != food.ID {
		t.Fatalf("returned %+v, want rent then food", got)
	}
	// Future mode: RA and BC change, TF doesn't, and nothing is recorded.
	if !got[0].RefillAmount.Equal(dec("800")) || !got[0].Capacity.Decimal.Equal(dec("800")) {
		t.Errorf("rent RA %s BC %s, want 800 with the fixed BC raised", got[0].RefillAmount, got[0].Capacity.Decimal)
	}
	if !got[1].RefillAmount.Equal(dec("1200")) || !got[1].Capacity.Decimal.Equal(dec("2400")) || !got[1].TargetFunds.Equal(dec("400")) {
		t.Errorf("food RA %s BC %s TF %s, want 1200, 2400, 400", got[1].RefillAmount, got[1].Capacity.Decimal, got[1].TargetFunds)
	}
	if c := e.count(t, sqlc.TransactionTypeBUA); c != txs {
		t.Errorf("%d BUA, want %d", c, txs)
	}

	// All or nothing: a bad item leaves the others as they were.
	if _, err := e.svc.SetRefillAmounts(t.Context(), e.user, []buckets.RefillAmount{
		{BucketID: food.ID, Amount: dec("10")},
		{BucketID: rent.ID, Amount: dec("-1")},
	}, false); !errors.Is(err, buckets.ErrInvalid) {
		t.Errorf("negative RA: %v", err)
	}
	if ra := e.get(t, food.ID).RefillAmount; !ra.Equal(dec("1200")) {
		t.Errorf("food RA %s after a refused batch, want 1200", ra)
	}
	if _, err := e.svc.SetRefillAmounts(t.Context(), e.user, []buckets.RefillAmount{
		{BucketID: food.ID, Amount: dec("10")},
		{BucketID: food.ID, Amount: dec("20")},
	}, false); !errors.Is(err, buckets.ErrInvalid) {
		t.Errorf("listed twice: %v", err)
	}
	bob := authtest.NewUser(t, e.pool, "bob").ID
	if _, err := e.svc.SetRefillAmounts(t.Context(), bob, []buckets.RefillAmount{{BucketID: food.ID, Amount: dec("10")}}, false); !errors.Is(err, buckets.ErrNotFound) {
		t.Errorf("bob sets alice's bucket: %v", err)
	}
}

func TestSetRefillAmountsThisCycle(t *testing.T) {
	e := setup(t)
	set := func(thisCycle bool, items ...buckets.RefillAmount) ([]buckets.Bucket, error) {
		t.Helper()
		return e.svc.SetRefillAmounts(t.Context(), e.user, items, thisCycle)
	}
	food := e.create(t, buckets.New{Name: "Food", RefillAmount: dec("1000")})
	if _, err := set(true, buckets.RefillAmount{BucketID: food.ID, Amount: dec("1200")}); !errors.Is(err, ledger.ErrNoActiveCycle) {
		t.Errorf("no active cycle: %v", err)
	}
	if ra := e.get(t, food.ID).RefillAmount; !ra.Equal(dec("1000")) {
		t.Errorf("RA %s after a refused save, want 1000", ra)
	}

	cycle := ledgertest.Cycle(t, e.pool, e.user, now.Add(-day), now.Add(29*day), "active")
	// Marked refilled by hand: these tests have no refill hook.
	refilled := func(n buckets.New) buckets.Bucket {
		t.Helper()
		b := e.create(t, n)
		if _, err := e.pool.Exec(t.Context(),
			"INSERT INTO refills (bucket_id, cycle_id, user_id, trigger) VALUES ($1, $2, $3, 'manual')", b.ID, cycle, e.user); err != nil {
			t.Fatal(err)
		}
		return b
	}
	rent := refilled(buckets.New{Name: "Rent", RefillAmount: dec("500"), OpeningFunds: dec("500")})
	fun := refilled(buckets.New{Name: "Fun", RefillAmount: dec("300"), OpeningFunds: dec("100")})
	same := refilled(buckets.New{Name: "Same", RefillAmount: dec("200"), OpeningFunds: dec("200")})
	waiting := e.create(t, buckets.New{Name: "Waiting", RefillAmount: dec("400"), RefillMode: sqlc.RefillModeOnIncome})
	bua := e.count(t, sqlc.TransactionTypeBUA)

	got, err := set(true,
		buckets.RefillAmount{BucketID: rent.ID, Amount: dec("800")},
		buckets.RefillAmount{BucketID: fun.ID, Amount: dec("100")},
		buckets.RefillAmount{BucketID: same.ID, Amount: dec("200")},
		buckets.RefillAmount{BucketID: waiting.ID, Amount: dec("600")},
	)
	if err != nil {
		t.Fatal(err)
	}
	// TF moves by the change in RA, below 0 too; the waiting bucket only gets the RA.
	for i, want := range []struct{ ra, tf string }{{"800", "800.00"}, {"100", "-100.00"}, {"200", "200.00"}, {"600", "0.00"}} {
		if !got[i].RefillAmount.Equal(dec(want.ra)) || got[i].TargetFunds.StringFixed(2) != want.tf {
			t.Errorf("%s: RA %s TF %s, want %s and %s", got[i].Name, got[i].RefillAmount, got[i].TargetFunds.StringFixed(2), want.ra, want.tf)
		}
	}
	if c := e.count(t, sqlc.TransactionTypeBUA); c != bua+2 {
		t.Errorf("%d BUA, want %d (rent and fun)", c, bua+2)
	}

	// Without this_cycle, only RA changes.
	if _, err := set(false, buckets.RefillAmount{BucketID: rent.ID, Amount: dec("900")}); err != nil {
		t.Fatal(err)
	}
	if tf := e.tf(t, rent.ID); tf != "800.00" {
		t.Errorf("rent TF %s after a future-only save, want 800.00", tf)
	}
}

// tf returns a bucket's TF.
func (e env) tf(t *testing.T, id string) string {
	t.Helper()
	tf, err := balance.Buckets(t.Context(), e.pool, e.user)
	if err != nil {
		t.Fatal(err)
	}
	return tf[id].StringFixed(2)
}

func TestAdjust(t *testing.T) {
	e := setup(t)
	b := e.create(t, buckets.New{Name: "Fuel", RefillAmount: dec("1000"), CapMode: sqlc.BucketCapModeFixed, CapAmount: dec("1200")})
	adjust := func(a buckets.Adjustment) (buckets.Bucket, error) {
		t.Helper()
		return e.svc.Adjust(t.Context(), e.user, b.ID, a)
	}
	// Recording a BUA needs an active cycle; Future doesn't.
	if _, err := adjust(buckets.Adjustment{Mode: buckets.ModeTemporary, TargetFunds: ptr(dec("500"))}); !errors.Is(err, ledger.ErrNoActiveCycle) {
		t.Errorf("temporary without a cycle: %v", err)
	}
	got, err := adjust(buckets.Adjustment{Mode: buckets.ModeFuture, RefillAmount: ptr(dec("1500"))})
	if err != nil {
		t.Fatal(err)
	}
	if !got.RefillAmount.Equal(dec("1500")) || !got.Capacity.Decimal.Equal(dec("1500")) || e.tf(t, b.ID) != "0.00" || e.count(t, sqlc.TransactionTypeBUA) != 0 {
		t.Errorf("future: RA %s BC %s TF %s, want 1500, the fixed BC raised, TF 0 and no BUA", got.RefillAmount, got.Capacity.Decimal, e.tf(t, b.ID))
	}

	e.startCycle(t)
	if _, err := adjust(buckets.Adjustment{Mode: buckets.ModeTemporary, TargetFunds: ptr(dec("600"))}); err != nil {
		t.Fatal(err)
	}
	if tf := e.tf(t, b.ID); tf != "600.00" || e.count(t, sqlc.TransactionTypeBUA) != 1 {
		t.Errorf("temporary: TF %s, want 600 with one BUA", tf)
	}
	// Both: TF changes by the RA's change, and may go below 0.
	if got, err = adjust(buckets.Adjustment{Mode: buckets.ModeBoth, RefillAmount: ptr(dec("1700"))}); err != nil {
		t.Fatal(err)
	}
	if tf := e.tf(t, b.ID); tf != "800.00" || !got.RefillAmount.Equal(dec("1700")) {
		t.Errorf("both, up: TF %s RA %s, want 800 and 1700", tf, got.RefillAmount)
	}
	if _, err = adjust(buckets.Adjustment{Mode: buckets.ModeBoth, RefillAmount: ptr(dec("500"))}); err != nil {
		t.Fatal(err)
	}
	if tf := e.tf(t, b.ID); tf != "-400.00" || e.count(t, sqlc.TransactionTypeBUA) != 3 {
		t.Errorf("both, down: TF %s, want -400 after three BUAs", tf)
	}

	for name, tc := range map[string]struct {
		a    buckets.Adjustment
		want error
	}{
		"negative TF":     {buckets.Adjustment{Mode: buckets.ModeTemporary, TargetFunds: ptr(dec("-1"))}, buckets.ErrInvalid},
		"same RA":         {buckets.Adjustment{Mode: buckets.ModeFuture, RefillAmount: ptr(dec("500.00"))}, buckets.ErrNoChange},
		"RA in temporary": {buckets.Adjustment{Mode: buckets.ModeTemporary, RefillAmount: ptr(dec("1"))}, buckets.ErrInvalid},
		"TF in both":      {buckets.Adjustment{Mode: buckets.ModeBoth, RefillAmount: ptr(dec("1")), TargetFunds: ptr(dec("1"))}, buckets.ErrInvalid},
		"negative RA":     {buckets.Adjustment{Mode: buckets.ModeFuture, RefillAmount: ptr(dec("-1"))}, buckets.ErrInvalid},
		"unknown mode":    {buckets.Adjustment{Mode: "weekly", RefillAmount: ptr(dec("1"))}, buckets.ErrInvalid},
	} {
		if _, err := adjust(tc.a); !errors.Is(err, tc.want) {
			t.Errorf("%s: %v, want %v", name, err, tc.want)
		}
	}
	if _, err := e.svc.Adjust(t.Context(), e.user, b.ID, buckets.Adjustment{Mode: buckets.ModeTemporary, TargetFunds: ptr(dec("0"))}); err != nil {
		t.Errorf("settle an overspent bucket: %v", err)
	}
	if _, err := adjust(buckets.Adjustment{Mode: buckets.ModeTemporary, TargetFunds: ptr(dec("0"))}); !errors.Is(err, buckets.ErrNoChange) {
		t.Errorf("same TF: %v", err)
	}
	bob := authtest.NewUser(t, e.pool, "bob").ID
	if _, err := e.svc.Adjust(t.Context(), bob, b.ID, buckets.Adjustment{Mode: buckets.ModeFuture, RefillAmount: ptr(dec("1"))}); !errors.Is(err, buckets.ErrNotFound) {
		t.Errorf("bob adjusts alice's bucket: %v", err)
	}
}

func TestTransfer(t *testing.T) {
	e := setup(t)
	e.startCycle(t)
	food := e.create(t, buckets.New{Name: "Food", RefillAmount: dec("1000"), OpeningFunds: dec("500")})
	fun := e.create(t, buckets.New{Name: "Fun", RefillAmount: dec("200"), CapMode: sqlc.BucketCapModeFixed, CapAmount: dec("300")})
	move := func(from, to string, mode buckets.Mode, amount string) (buckets.Bucket, buckets.Bucket, error) {
		t.Helper()
		return e.svc.Transfer(t.Context(), e.user, from, buckets.Transfer{To: to, Mode: mode, Amount: dec(amount)})
	}

	if _, _, err := move(food.ID, fun.ID, buckets.ModeTemporary, "150"); err != nil {
		t.Fatal(err)
	}
	if e.tf(t, food.ID) != "350.00" || e.tf(t, fun.ID) != "150.00" || e.count(t, sqlc.TransactionTypeBAT) != 1 {
		t.Errorf("temporary: TF %s and %s, want 350 and 150 with one BAT", e.tf(t, food.ID), e.tf(t, fun.ID))
	}
	from, to, err := move(food.ID, fun.ID, buckets.ModeFuture, "200")
	if err != nil {
		t.Fatal(err)
	}
	if !from.RefillAmount.Equal(dec("800")) || !to.RefillAmount.Equal(dec("400")) || !to.Capacity.Decimal.Equal(dec("400")) ||
		e.tf(t, fun.ID) != "150.00" || e.count(t, sqlc.TransactionTypeBAT) != 1 {
		t.Errorf("future: RA %s and %s (BC %s), want 800 and 400 with the fixed BC raised, TF unchanged", from.RefillAmount, to.RefillAmount, to.Capacity.Decimal)
	}
	if from, to, err = move(fun.ID, food.ID, buckets.ModeBoth, "100"); err != nil {
		t.Fatal(err)
	}
	if !from.RefillAmount.Equal(dec("300")) || !to.RefillAmount.Equal(dec("900")) || e.tf(t, fun.ID) != "50.00" || e.tf(t, food.ID) != "450.00" {
		t.Errorf("both: RA %s and %s, TF %s and %s", from.RefillAmount, to.RefillAmount, e.tf(t, fun.ID), e.tf(t, food.ID))
	}
	// This cycle may go below 0.
	if _, _, err := move(fun.ID, food.ID, buckets.ModeTemporary, "80"); err != nil || e.tf(t, fun.ID) != "-30.00" {
		t.Errorf("temporary below 0: %v, TF %s", err, e.tf(t, fun.ID))
	}

	eur := e.create(t, buckets.New{Name: "Euro", SourceAccountID: ledgertest.Account(t, e.pool, e.user, "EUR")})
	for name, tc := range map[string]struct {
		from, to string
		mode     buckets.Mode
		amount   string
		want     error
	}{
		"to itself":        {food.ID, food.ID, buckets.ModeTemporary, "1", buckets.ErrInvalid},
		"zero":             {food.ID, fun.ID, buckets.ModeTemporary, "0", buckets.ErrInvalid},
		"other currency":   {food.ID, eur.ID, buckets.ModeTemporary, "1", buckets.ErrCurrencyMismatch},
		"more than the RA": {fun.ID, food.ID, buckets.ModeFuture, "300.01", buckets.ErrInvalid},
		"unknown mode":     {food.ID, fun.ID, "weekly", "1", buckets.ErrInvalid},
		"unknown bucket":   {food.ID, "1234567890", buckets.ModeTemporary, "1", buckets.ErrNotFound},
	} {
		if _, _, err := move(tc.from, tc.to, tc.mode, tc.amount); !errors.Is(err, tc.want) {
			t.Errorf("%s: %v, want %v", name, err, tc.want)
		}
	}
}

func TestUpdateSource(t *testing.T) {
	e := setup(t)
	b := e.create(t, buckets.New{Name: "Fuel"})
	if _, err := e.pool.Exec(t.Context(), "UPDATE buckets SET caf = 700 WHERE id = $1", b.ID); err != nil {
		t.Fatal(err)
	}
	eur := ledgertest.Account(t, e.pool, e.user, "EUR")
	if _, err := e.svc.Update(t.Context(), e.user, b.ID, buckets.Changes{SourceAccountID: &eur}); !errors.Is(err, buckets.ErrCurrencyMismatch) {
		t.Errorf("to EUR: %v", err)
	}
	if _, err := e.svc.Update(t.Context(), e.user, b.ID, buckets.Changes{SourceAccountID: ptr(ledgertest.UnusedAccountID(t, e.pool))}); !errors.Is(err, buckets.ErrInvalid) {
		t.Errorf("to an unknown account: %v", err)
	}

	// The same account changes nothing.
	got, err := e.svc.Update(t.Context(), e.user, b.ID, buckets.Changes{SourceAccountID: &e.account})
	if err != nil || !got.Caf.Equal(dec("700")) {
		t.Errorf("same source: %v, CAF %s", err, got.Caf)
	}

	other := ledgertest.Account(t, e.pool, e.user, "NOK")
	got, err = e.svc.Update(t.Context(), e.user, b.ID, buckets.Changes{SourceAccountID: &other})
	if err != nil {
		t.Fatal(err)
	}
	if got.SourceAccountID != other || !got.Caf.IsZero() {
		t.Errorf("moved: source %s CAF %s, want %s and 0", got.SourceAccountID, got.Caf, other)
	}
}

func TestDelete(t *testing.T) {
	e := setup(t)
	empty := e.create(t, buckets.New{Name: "Empty"})
	if err := e.svc.Delete(t.Context(), e.user, empty.ID); err != nil {
		t.Fatalf("delete with TF 0 and no cycle: %v", err)
	}
	if _, err := e.svc.Get(t.Context(), e.user, empty.ID); !errors.Is(err, buckets.ErrNotFound) {
		t.Errorf("get deleted: %v", err)
	}
	// The name is free again.
	e.create(t, buckets.New{Name: "Empty"})

	e.startCycle(t)
	b := e.create(t, buckets.New{Name: "Groceries", OpeningFunds: dec("300")})
	if _, err := e.pool.Exec(t.Context(), "UPDATE buckets SET caf = 300 WHERE id = $1", b.ID); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.Delete(t.Context(), e.user, b.ID); err != nil {
		t.Fatal(err)
	}
	tf, err := balance.Buckets(t.Context(), e.pool, e.user)
	if err != nil {
		t.Fatal(err)
	}
	if !tf[b.ID].IsZero() {
		t.Errorf("TF after delete %s, want 0", tf[b.ID])
	}
	if n := e.count(t, sqlc.TransactionTypeBUA); n != 1 {
		t.Errorf("%d BUA transactions, want 1", n)
	}
	var caf decimal.Decimal
	if err := e.pool.QueryRow(t.Context(), "SELECT caf FROM buckets WHERE id = $1", b.ID).Scan(&caf); err != nil || !caf.IsZero() {
		t.Errorf("CAF after delete %s (%v), want 0", caf, err)
	}
	if err := e.svc.Delete(t.Context(), e.user, b.ID); !errors.Is(err, buckets.ErrNotFound) {
		t.Errorf("delete twice: %v", err)
	}
}

func TestDeleteNegative(t *testing.T) {
	e := setup(t)
	e.startCycle(t)
	b := e.create(t, buckets.New{Name: "Fun", OpeningFunds: dec("100")})
	// Overspent: TF is −200.
	if _, err := e.ledger.Create(t.Context(), e.pool, ledger.Entry{
		UserID: e.user, Type: sqlc.TransactionTypeBUA, At: now,
		BucketLines: []ledger.BucketLine{{BucketID: b.ID, Amount: dec("-300")}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.Delete(t.Context(), e.user, b.ID); err != nil {
		t.Fatal(err)
	}
	tf, err := balance.Buckets(t.Context(), e.pool, e.user)
	if err != nil {
		t.Fatal(err)
	}
	if !tf[b.ID].IsZero() {
		t.Errorf("TF after delete %s, want 0", tf[b.ID])
	}
}

func TestDeleteNeedsCycle(t *testing.T) {
	e := setup(t)
	e.startCycle(t)
	b := e.create(t, buckets.New{Name: "Groceries", OpeningFunds: dec("300")})
	if _, err := e.pool.Exec(t.Context(), "UPDATE cycles SET state = 'finished' WHERE user_id = $1", e.user); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.Delete(t.Context(), e.user, b.ID); !errors.Is(err, ledger.ErrNoActiveCycle) {
		t.Fatalf("delete with TF and no cycle: %v", err)
	}
	if got := e.get(t, b.ID); !got.TargetFunds.Equal(dec("300")) {
		t.Errorf("TF %s after a refused delete, want 300", got.TargetFunds)
	}
}

func TestIsolation(t *testing.T) {
	e := setup(t)
	b := e.create(t, buckets.New{Name: "Groceries"})
	bob := authtest.NewUser(t, e.pool, "bob").ID
	if _, err := e.svc.Get(t.Context(), bob, b.ID); !errors.Is(err, buckets.ErrNotFound) {
		t.Errorf("bob gets alice's bucket: %v", err)
	}
	if _, err := e.svc.Update(t.Context(), bob, b.ID, buckets.Changes{Name: ptr("Mine")}); !errors.Is(err, buckets.ErrNotFound) {
		t.Errorf("bob updates alice's bucket: %v", err)
	}
	if err := e.svc.Delete(t.Context(), bob, b.ID); !errors.Is(err, buckets.ErrNotFound) {
		t.Errorf("bob deletes alice's bucket: %v", err)
	}
	if list, err := e.svc.List(t.Context(), bob); err != nil || len(list) != 0 {
		t.Errorf("bob's list %v %v", list, err)
	}
	// Bob's own bucket may have the same name.
	if _, err := e.svc.Create(t.Context(), bob, buckets.New{Name: "Groceries", SourceAccountID: ledgertest.Account(t, e.pool, bob, "NOK")}); err != nil {
		t.Errorf("bob's bucket with alice's name: %v", err)
	}
}
