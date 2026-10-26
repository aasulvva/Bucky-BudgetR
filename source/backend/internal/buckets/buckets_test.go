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
	if !b.Capacity.Equal(dec("4000")) || !b.TargetFunds.IsZero() || !b.Caf.IsZero() {
		t.Errorf("BC %s TF %s CAF %s", b.Capacity, b.TargetFunds, b.Caf)
	}
	// No opening funds: nothing recorded, and no cycle needed.
	if n := e.count(t, sqlc.TransactionTypeOPF); n != 0 {
		t.Errorf("%d OPF transactions, want 0", n)
	}

	got := e.get(t, b.ID)
	if got.Name != b.Name || !got.Capacity.Equal(b.Capacity) {
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
	if !b.Capacity.Equal(dec("1500.08")) {
		t.Errorf("BC %s, want 1000.05 × 1.5 rounded = 1500.08", b.Capacity)
	}
	b = e.create(t, buckets.New{Name: "Rent", RefillAmount: dec("9000"), CapMode: sqlc.BucketCapModeFixed, CapAmount: dec("8000")})
	if !b.CapAmount.Decimal.Equal(dec("9000")) || !b.Capacity.Equal(dec("9000")) || b.CapMultiplier.Valid {
		t.Errorf("fixed BC %v / %s, want raised to RA 9000", b.CapAmount, b.Capacity)
	}
	b = e.create(t, buckets.New{Name: "Gifts", RefillAmount: dec("500"), CapMode: sqlc.BucketCapModeFixed, CapAmount: dec("2000")})
	if !b.Capacity.Equal(dec("2000")) {
		t.Errorf("fixed BC %s, want 2000", b.Capacity)
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
	if got.Name != "Car" || !got.Capacity.Equal(dec("2400")) || !got.KeepFunds || got.RefillMode != sqlc.RefillModeManual ||
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
	if got.CapMultiplier.Valid || !got.Capacity.Equal(dec("1200")) {
		t.Errorf("switched to fixed: %v / %s, want BC = RA", got.CapMultiplier, got.Capacity)
	}
	// A fixed amount below RA is raised to it.
	if got, err = e.svc.Update(t.Context(), e.user, b.ID, buckets.Changes{CapAmount: ptr(dec("100"))}); err != nil || !got.Capacity.Equal(dec("1200")) {
		t.Errorf("fixed below RA: %v, BC %s", err, got.Capacity)
	}
	// Raising RA above the fixed amount raises BC.
	if got, err = e.svc.Update(t.Context(), e.user, b.ID, buckets.Changes{RefillAmount: ptr(dec("1500"))}); err != nil || !got.Capacity.Equal(dec("1500")) {
		t.Errorf("RA above fixed BC: %v, BC %s", err, got.Capacity)
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
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].ID != rent.ID || got[1].ID != food.ID {
		t.Fatalf("returned %+v, want rent then food", got)
	}
	// Future mode: RA and BC change, TF doesn't, and nothing is recorded.
	if !got[0].RefillAmount.Equal(dec("800")) || !got[0].Capacity.Equal(dec("800")) {
		t.Errorf("rent RA %s BC %s, want 800 with the fixed BC raised", got[0].RefillAmount, got[0].Capacity)
	}
	if !got[1].RefillAmount.Equal(dec("1200")) || !got[1].Capacity.Equal(dec("2400")) || !got[1].TargetFunds.Equal(dec("400")) {
		t.Errorf("food RA %s BC %s TF %s, want 1200, 2400, 400", got[1].RefillAmount, got[1].Capacity, got[1].TargetFunds)
	}
	if c := e.count(t, sqlc.TransactionTypeBUA); c != txs {
		t.Errorf("%d BUA, want %d", c, txs)
	}

	// All or nothing: a bad item leaves the others as they were.
	if _, err := e.svc.SetRefillAmounts(t.Context(), e.user, []buckets.RefillAmount{
		{BucketID: food.ID, Amount: dec("10")},
		{BucketID: rent.ID, Amount: dec("-1")},
	}); !errors.Is(err, buckets.ErrInvalid) {
		t.Errorf("negative RA: %v", err)
	}
	if ra := e.get(t, food.ID).RefillAmount; !ra.Equal(dec("1200")) {
		t.Errorf("food RA %s after a refused batch, want 1200", ra)
	}
	if _, err := e.svc.SetRefillAmounts(t.Context(), e.user, []buckets.RefillAmount{
		{BucketID: food.ID, Amount: dec("10")},
		{BucketID: food.ID, Amount: dec("20")},
	}); !errors.Is(err, buckets.ErrInvalid) {
		t.Errorf("listed twice: %v", err)
	}
	bob := authtest.NewUser(t, e.pool, "bob").ID
	if _, err := e.svc.SetRefillAmounts(t.Context(), bob, []buckets.RefillAmount{{BucketID: food.ID, Amount: dec("10")}}); !errors.Is(err, buckets.ErrNotFound) {
		t.Errorf("bob sets alice's bucket: %v", err)
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
