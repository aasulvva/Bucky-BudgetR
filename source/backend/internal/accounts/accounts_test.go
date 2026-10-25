package accounts_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledgertest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

func dec(s string) decimal.Decimal { return decimal.RequireFromString(s) }

var now = time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)

type env struct {
	pool   *pgxpool.Pool
	svc    *accounts.Service
	ledger *ledger.Ledger
	user   string
}

func setup(t *testing.T) env {
	t.Helper()
	pool := testdb.New(t)
	l := ledger.New(ledger.Options{})
	return env{
		pool:   pool,
		svc:    accounts.NewService(pool, l, accounts.Options{Now: func() time.Time { return now }}),
		ledger: l,
		user:   authtest.NewUser(t, pool, "alice").ID,
	}
}

func (e env) create(t *testing.T, name, opening string) accounts.Account {
	t.Helper()
	n := accounts.New{Name: name}
	if opening != "" {
		n.OpeningBalance = dec(opening)
	}
	a, err := e.svc.Create(t.Context(), e.user, n)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func (e env) balance(t *testing.T, id string) decimal.Decimal {
	t.Helper()
	a, err := e.svc.Get(t.Context(), e.user, id)
	if err != nil {
		t.Fatal(err)
	}
	return a.Balance
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
	a := e.create(t, "  Main account ", "1500.50")
	if a.Name != "Main account" || a.Type != sqlc.AccountTypeUsage || a.Currency != "NOK" || !a.Balance.Equal(dec("1500.50")) {
		t.Errorf("unexpected account %+v", a)
	}
	if got := e.balance(t, a.ID); !got.Equal(dec("1500.50")) {
		t.Errorf("stored balance %s", got)
	}
	if n := e.count(t, sqlc.TransactionTypeOPB); n != 1 {
		t.Errorf("%d OPB transactions, want 1", n)
	}

	// No opening balance, no OPB.
	b, err := e.svc.Create(t.Context(), e.user, accounts.New{Name: "Savings", Type: sqlc.AccountTypeSavings, Currency: "EUR"})
	if err != nil {
		t.Fatal(err)
	}
	if b.Type != sqlc.AccountTypeSavings || b.Currency != "EUR" || !b.Balance.IsZero() || e.count(t, sqlc.TransactionTypeOPB) != 1 {
		t.Errorf("unexpected account %+v", b)
	}

	list, err := e.svc.List(t.Context(), e.user)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].Name != "Main account" || list[1].Name != "Savings" {
		t.Errorf("list %+v", list)
	}

	for name, tc := range map[string]struct {
		n    accounts.New
		want error
	}{
		"empty name":         {accounts.New{Name: "   "}, accounts.ErrInvalid},
		"long name":          {accounts.New{Name: strings.Repeat("x", 101)}, accounts.ErrInvalid},
		"bad type":           {accounts.New{Name: "x", Type: "cash"}, accounts.ErrInvalid},
		"bad currency":       {accounts.New{Name: "x", Currency: "nok"}, accounts.ErrInvalid},
		"unknown currency":   {accounts.New{Name: "x", Currency: "XYZ"}, accounts.ErrInvalid},
		"3-decimal currency": {accounts.New{Name: "x", Currency: "KWD"}, accounts.ErrInvalid},
		"3 decimals":         {accounts.New{Name: "x", OpeningBalance: dec("1.005")}, accounts.ErrInvalid},
		"name taken":         {accounts.New{Name: "MAIN ACCOUNT"}, accounts.ErrNameTaken},
		"name taken, typed":  {accounts.New{Name: "savings", Type: sqlc.AccountTypeBsu}, accounts.ErrNameTaken},
	} {
		if _, err := e.svc.Create(t.Context(), e.user, tc.n); !errors.Is(err, tc.want) {
			t.Errorf("%s: got %v, want %v", name, err, tc.want)
		}
	}

	// Another user may use the same name, and can't see alice's accounts.
	bob := authtest.NewUser(t, e.pool, "bob").ID
	if _, err := e.svc.Create(t.Context(), bob, accounts.New{Name: "Main account"}); err != nil {
		t.Errorf("same name for another user: %v", err)
	}
	if _, err := e.svc.Get(t.Context(), bob, a.ID); !errors.Is(err, accounts.ErrNotFound) {
		t.Errorf("bob gets alice's account: %v", err)
	}
}

func TestUpdate(t *testing.T) {
	e := setup(t)
	a := e.create(t, "Main", "100")
	e.create(t, "Buffer", "")

	name, typ := "Everyday", sqlc.AccountTypeSavings
	got, err := e.svc.Update(t.Context(), e.user, a.ID, accounts.Changes{Name: &name, Type: &typ})
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "Everyday" || got.Type != sqlc.AccountTypeSavings || !got.Balance.Equal(dec("100")) {
		t.Errorf("unexpected account %+v", got)
	}
	taken := "buffer"
	if _, err := e.svc.Update(t.Context(), e.user, a.ID, accounts.Changes{Name: &taken}); !errors.Is(err, accounts.ErrNameTaken) {
		t.Errorf("rename to a taken name: %v", err)
	}
	bob := authtest.NewUser(t, e.pool, "bob").ID
	if _, err := e.svc.Update(t.Context(), bob, a.ID, accounts.Changes{Name: &name}); !errors.Is(err, accounts.ErrNotFound) {
		t.Errorf("bob updates alice's account: %v", err)
	}
}

func TestAdjustBalance(t *testing.T) {
	e := setup(t)
	a, err := e.svc.Create(t.Context(), e.user, accounts.New{Name: "Fund", OpeningBalance: dec("1000"), OpeningAt: now.Add(-48 * time.Hour)})
	if err != nil {
		t.Fatal(err)
	}

	got, err := e.svc.AdjustBalance(t.Context(), e.user, a.ID, accounts.Adjustment{Target: dec("1250.75")})
	if err != nil {
		t.Fatal(err)
	}
	if !got.Balance.Equal(dec("1250.75")) {
		t.Errorf("balance %s, want 1250.75", got.Balance)
	}
	if _, err := e.svc.AdjustBalance(t.Context(), e.user, a.ID, accounts.Adjustment{Target: dec("1250.75")}); !errors.Is(err, accounts.ErrNoChange) {
		t.Errorf("no change: %v", err)
	}

	// In the past, only what was there at that moment counts: the balance
	// was 1000 a day ago, so setting it to 900 then records −100.
	got, err = e.svc.AdjustBalance(t.Context(), e.user, a.ID, accounts.Adjustment{Target: dec("900"), At: now.Add(-24 * time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if !got.Balance.Equal(dec("1150.75")) {
		t.Errorf("balance %s, want 1150.75", got.Balance)
	}
	if n := e.count(t, sqlc.TransactionTypeBLA); n != 2 {
		t.Errorf("%d BLA transactions, want 2", n)
	}
}

func TestDelete(t *testing.T) {
	ctx := context.Background()

	t.Run("empty account", func(t *testing.T) {
		e := setup(t)
		a := e.create(t, "Old", "")
		if err := e.svc.Delete(ctx, e.user, a.ID, accounts.Settlement{}); err != nil {
			t.Fatal(err)
		}
		if _, err := e.svc.Get(ctx, e.user, a.ID); !errors.Is(err, accounts.ErrNotFound) {
			t.Errorf("deleted account still found: %v", err)
		}
		// The name is free again.
		e.create(t, "Old", "")
	})

	t.Run("money left", func(t *testing.T) {
		e := setup(t)
		a := e.create(t, "Old", "500")
		err := e.svc.Delete(ctx, e.user, a.ID, accounts.Settlement{})
		var notZero *accounts.BalanceNotZeroError
		if !errors.As(err, &notZero) || !notZero.Balance.Equal(dec("500")) {
			t.Fatalf("got %v, want BalanceNotZeroError(500)", err)
		}
		e.balance(t, a.ID) // still there
	})

	t.Run("transfer", func(t *testing.T) {
		e := setup(t)
		a := e.create(t, "Old", "500")
		to := e.create(t, "New", "100")
		if err := e.svc.Delete(ctx, e.user, a.ID, accounts.Settlement{Remaining: &accounts.Remaining{TransferTo: to.ID}}); err != nil {
			t.Fatal(err)
		}
		if got := e.balance(t, to.ID); !got.Equal(dec("600")) {
			t.Errorf("target balance %s, want 600", got)
		}
		if n := e.count(t, sqlc.TransactionTypeTRF); n != 1 {
			t.Errorf("%d transfers, want 1", n)
		}
	})

	t.Run("adjust", func(t *testing.T) {
		e := setup(t)
		a := e.create(t, "Old", "-42.10")
		if err := e.svc.Delete(ctx, e.user, a.ID, accounts.Settlement{Remaining: &accounts.Remaining{Adjust: true}}); err != nil {
			t.Fatal(err)
		}
		var sum decimal.Decimal
		if err := e.pool.QueryRow(ctx, "SELECT sum(amount) FROM bank_transactions WHERE account_id = $1", a.ID).Scan(&sum); err != nil {
			t.Fatal(err)
		}
		if !sum.IsZero() || e.count(t, sqlc.TransactionTypeBLA) != 1 {
			t.Errorf("balance after adjusting %s", sum)
		}
	})

	t.Run("buckets", func(t *testing.T) {
		e := setup(t)
		a := e.create(t, "Old", "")
		to := e.create(t, "New", "")
		b1 := ledgertest.Bucket(t, e.pool, e.user, a.ID)
		b2 := ledgertest.Bucket(t, e.pool, e.user, a.ID)
		gone := ledgertest.Bucket(t, e.pool, e.user, a.ID)
		ledgertest.Delete(t, e.pool, "buckets", gone) // deleted buckets don't count

		err := e.svc.Delete(ctx, e.user, a.ID, accounts.Settlement{BucketSources: map[string]string{b1: to.ID}})
		var has *accounts.HasBucketsError
		if !errors.As(err, &has) || len(has.BucketIDs) != 1 || has.BucketIDs[0] != b2 {
			t.Fatalf("got %v, want HasBucketsError(%s)", err, b2)
		}
		if err := e.svc.Delete(ctx, e.user, a.ID, accounts.Settlement{BucketSources: map[string]string{b1: to.ID, b2: to.ID}}); err != nil {
			t.Fatal(err)
		}
		var moved int
		if err := e.pool.QueryRow(ctx, "SELECT count(*) FROM buckets WHERE source_account_id = $1", to.ID).Scan(&moved); err != nil {
			t.Fatal(err)
		}
		if moved != 2 {
			t.Errorf("%d buckets moved, want 2", moved)
		}
	})

	t.Run("refused", func(t *testing.T) {
		e := setup(t)
		a := e.create(t, "Old", "500")
		other := e.create(t, "Other", "")
		euro, err := e.svc.Create(ctx, e.user, accounts.New{Name: "Euro", Currency: "EUR"})
		if err != nil {
			t.Fatal(err)
		}
		b := ledgertest.Bucket(t, e.pool, e.user, a.ID)
		otherBucket := ledgertest.Bucket(t, e.pool, e.user, other.ID)
		bob := authtest.NewUser(t, e.pool, "bob").ID
		bobAcc, err := e.svc.Create(ctx, bob, accounts.New{Name: "Bob's"})
		if err != nil {
			t.Fatal(err)
		}
		keep := map[string]string{b: other.ID}
		transfer := func(to string) *accounts.Remaining { return &accounts.Remaining{TransferTo: to} }

		for name, tc := range map[string]struct {
			st   accounts.Settlement
			want error
		}{
			"transfer to itself":    {accounts.Settlement{BucketSources: keep, Remaining: transfer(a.ID)}, accounts.ErrInvalid},
			"transfer to bob":       {accounts.Settlement{BucketSources: keep, Remaining: transfer(bobAcc.ID)}, accounts.ErrInvalid},
			"transfer to euro":      {accounts.Settlement{BucketSources: keep, Remaining: transfer(euro.ID)}, accounts.ErrCurrencyMismatch},
			"both transfer, adjust": {accounts.Settlement{BucketSources: keep, Remaining: &accounts.Remaining{TransferTo: other.ID, Adjust: true}}, accounts.ErrInvalid},
			"bucket to euro":        {accounts.Settlement{BucketSources: map[string]string{b: euro.ID}, Remaining: transfer(other.ID)}, accounts.ErrCurrencyMismatch},
			"bucket to itself":      {accounts.Settlement{BucketSources: map[string]string{b: a.ID}, Remaining: transfer(other.ID)}, accounts.ErrInvalid},
			"foreign bucket":        {accounts.Settlement{BucketSources: map[string]string{b: other.ID, otherBucket: other.ID}}, accounts.ErrInvalid},
		} {
			if err := e.svc.Delete(ctx, e.user, a.ID, tc.st); !errors.Is(err, tc.want) {
				t.Errorf("%s: got %v, want %v", name, err, tc.want)
			}
		}
		if err := e.svc.Delete(ctx, bob, a.ID, accounts.Settlement{}); !errors.Is(err, accounts.ErrNotFound) {
			t.Errorf("bob deletes alice's account: %v", err)
		}
		// Nothing changed.
		if got := e.balance(t, a.ID); !got.Equal(dec("500")) {
			t.Errorf("balance %s, want 500", got)
		}
		if e.count(t, sqlc.TransactionTypeTRF)+e.count(t, sqlc.TransactionTypeBLA) != 0 {
			t.Error("a refused delete recorded transactions")
		}
	})
}

// A transaction can't be recorded on an account deleted meanwhile.
func TestRecordOnDeletedAccount(t *testing.T) {
	e := setup(t)
	a := e.create(t, "Old", "")
	if err := e.svc.Delete(t.Context(), e.user, a.ID, accounts.Settlement{}); err != nil {
		t.Fatal(err)
	}
	_, err := e.ledger.Create(t.Context(), e.pool, ledger.Entry{
		UserID: e.user, Type: sqlc.TransactionTypeINC, At: now,
		BankLines: []ledger.BankLine{{AccountID: a.ID, Amount: dec("1")}},
	})
	if !errors.Is(err, ledger.ErrNotFound) {
		t.Errorf("got %v, want ledger.ErrNotFound", err)
	}
}
