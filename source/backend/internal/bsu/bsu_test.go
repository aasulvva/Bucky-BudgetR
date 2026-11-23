package bsu_test

import (
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/bsu"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledgertest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

func dec(s string) decimal.Decimal { return decimal.RequireFromString(s) }

var now = time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)

type env struct {
	pool     *pgxpool.Pool
	bsu      *bsu.Service
	accounts *accounts.Service
	tx       *transactions.Service
	user     string
	usage    string
}

func setup(t *testing.T) env {
	t.Helper()
	pool := testdb.New(t)
	l := ledger.New(ledger.Options{})
	clock := func() time.Time { return now }
	user := authtest.NewUser(t, pool, "alice").ID
	e := env{
		pool:     pool,
		bsu:      bsu.NewService(pool, l, bsu.Options{Now: clock}),
		accounts: accounts.NewService(pool, l, accounts.Options{Now: clock}),
		tx:       transactions.NewService(pool, l, transactions.Options{Now: clock}),
		user:     user,
	}
	e.usage = ledgertest.Account(t, pool, user, "NOK")
	return e
}

// account creates a BSU account with an opening balance.
func (e env) account(t *testing.T, opening string) string {
	t.Helper()
	a, err := e.accounts.Create(t.Context(), e.user, accounts.New{
		Name: "BSU", Type: sqlc.AccountTypeBsu, OpeningBalance: dec(opening), OpeningAt: now.AddDate(0, -1, 0),
	})
	if err != nil {
		t.Fatal(err)
	}
	return a.ID
}

// setUp marks the account set up without changing its transactions.
func (e env) setUp(t *testing.T, id string) {
	t.Helper()
	if _, err := e.pool.Exec(t.Context(), "UPDATE bank_accounts SET bsu_set_up_at = now() WHERE id = $1", id); err != nil {
		t.Fatal(err)
	}
}

func (e env) create(t *testing.T, n transactions.New) transactions.Transaction {
	t.Helper()
	tr, err := e.tx.Create(t.Context(), e.user, n)
	if err != nil {
		t.Fatal(err)
	}
	return tr
}

func (e env) status(t *testing.T, id string) bsu.Status {
	t.Helper()
	a, err := e.accounts.Get(t.Context(), e.user, id)
	if err != nil {
		t.Fatal(err)
	}
	if a.BSU == nil {
		t.Fatalf("account %s has no BSU status", id)
	}
	return *a.BSU
}

func (e env) balance(t *testing.T, id string) string {
	t.Helper()
	a, err := e.accounts.Get(t.Context(), e.user, id)
	if err != nil {
		t.Fatal(err)
	}
	return a.Balance.StringFixed(2)
}

func TestYear(t *testing.T) {
	// 23:30 UTC on New Year's Eve is past midnight in Oslo.
	if y := bsu.Year(time.Date(2025, 12, 31, 23, 30, 0, 0, time.UTC)); y != 2026 {
		t.Errorf("year %d, want 2026", y)
	}
	if y := bsu.Year(time.Date(2025, 12, 31, 22, 30, 0, 0, time.UTC)); y != 2025 {
		t.Errorf("year %d, want 2025", y)
	}
	from, to := bsu.YearBounds(2026)
	if !from.Equal(time.Date(2025, 12, 31, 23, 0, 0, 0, time.UTC)) || !to.Equal(time.Date(2026, 12, 31, 23, 0, 0, 0, time.UTC)) {
		t.Errorf("bounds %s – %s", from, to)
	}
}

func TestFor(t *testing.T) {
	list := []bsu.Rule{{FromYear: 2016, YearlyLimit: dec("25000")}, {FromYear: 2021, YearlyLimit: dec("27500")}}
	for year, want := range map[int]int{2010: 2016, 2016: 2016, 2020: 2016, 2021: 2021, 2030: 2021} {
		if got := bsu.For(list, year).FromYear; got != want {
			t.Errorf("For(%d) = %d, want %d", year, got, want)
		}
	}
}

func TestRules(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	list, err := e.bsu.Rules(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].FromYear != 2021 || list[0].YearlyLimit.StringFixed(2) != "27500.00" || list[0].TotalLimit.StringFixed(2) != "300000.00" {
		t.Fatalf("seeded rules %+v", list)
	}
	if _, err := e.bsu.DeleteRule(ctx, 2021); !errors.Is(err, bsu.ErrLastRule) {
		t.Errorf("deleting the last rule: %v", err)
	}
	for _, bad := range []bsu.Rule{
		{FromYear: 1999, YearlyLimit: dec("1"), TotalLimit: dec("1")},
		{FromYear: 2027, YearlyLimit: dec("0"), TotalLimit: dec("1")},
		{FromYear: 2027, YearlyLimit: dec("30000"), TotalLimit: dec("20000")},
	} {
		if _, _, err := e.bsu.SetRule(ctx, e.user, bad); !errors.Is(err, bsu.ErrInvalid) {
			t.Errorf("SetRule(%+v): %v", bad, err)
		}
	}
	before, after, err := e.bsu.SetRule(ctx, e.user, bsu.Rule{FromYear: 2027, YearlyLimit: dec("30000"), TotalLimit: dec("350000")})
	if err != nil || before != nil || after.FromYear != 2027 {
		t.Fatalf("new rule: %v %+v %+v", err, before, after)
	}
	before, after, err = e.bsu.SetRule(ctx, e.user, bsu.Rule{FromYear: 2027, YearlyLimit: dec("32000"), TotalLimit: dec("350000")})
	if err != nil || before == nil || before.YearlyLimit.StringFixed(2) != "30000.00" || after.YearlyLimit.StringFixed(2) != "32000.00" {
		t.Fatalf("changed rule: %v %+v %+v", err, before, after)
	}
	if _, err := e.bsu.DeleteRule(ctx, 2030); !errors.Is(err, bsu.ErrNotFound) {
		t.Errorf("deleting a missing rule: %v", err)
	}
	if old, err := e.bsu.DeleteRule(ctx, 2027); err != nil || old.YearlyLimit.StringFixed(2) != "32000.00" {
		t.Errorf("delete: %v %+v", err, old)
	}
}

// TestDeposits: what counts as a deposit, and the check on create and
// correct.
func TestDeposits(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	id := e.account(t, "1000") // the OPB isn't a deposit
	e.setUp(t, id)

	// Last year's deposits count towards the total only.
	e.create(t, transactions.New{Type: sqlc.TransactionTypeINC, AccountID: id, Amount: dec("27000"), At: time.Date(2025, 6, 1, 0, 0, 0, 0, time.UTC)})
	inc := e.create(t, transactions.New{Type: sqlc.TransactionTypeINC, AccountID: id, Amount: dec("20000"), At: now.Add(-time.Hour)})
	e.create(t, transactions.New{Type: sqlc.TransactionTypeTRF, AccountID: e.usage, ToAccountID: id, Amount: dec("5000"), At: now.Add(-time.Hour)})
	interest := e.create(t, transactions.New{
		Type: sqlc.TransactionTypeINC, AccountID: id, Amount: dec("1000"), Tags: []string{"Interest"}, At: now.Add(-time.Hour),
	})
	// A reversed deposit counts as nothing.
	rev := e.create(t, transactions.New{Type: sqlc.TransactionTypeINC, AccountID: id, Amount: dec("2000"), At: now.Add(-time.Hour)})
	if _, err := e.tx.Reverse(ctx, e.user, rev.ID); err != nil {
		t.Fatal(err)
	}

	st := e.status(t, id)
	if st.Year != 2026 || st.DepositedYear.StringFixed(2) != "25000.00" || st.DepositedTotal.StringFixed(2) != "52000.00" ||
		st.LeftYear.StringFixed(2) != "2500.00" || st.LeftTotal.StringFixed(2) != "248000.00" || st.Over || st.Locked {
		t.Fatalf("status %+v", st)
	}

	// Over the yearly limit: refused, unless confirmed.
	_, err := e.tx.Create(ctx, e.user, transactions.New{Type: sqlc.TransactionTypeINC, AccountID: id, Amount: dec("3000")})
	var over *bsu.OverLimitError
	if !errors.As(err, &over) || over.AccountID != id || over.LeftYear.StringFixed(2) != "2500.00" || over.Year != 2026 {
		t.Fatalf("over the limit: %v", err)
	}
	_, err = e.tx.Create(ctx, e.user, transactions.New{Type: sqlc.TransactionTypeTRF, AccountID: e.usage, ToAccountID: id, Amount: dec("2600")})
	if !errors.As(err, &over) {
		t.Fatalf("a transfer over the limit: %v", err)
	}
	// Up to the limit, and interest, are fine.
	e.create(t, transactions.New{Type: sqlc.TransactionTypeINC, AccountID: id, Amount: dec("2500")})
	e.create(t, transactions.New{Type: sqlc.TransactionTypeINC, AccountID: id, Amount: dec("50"), Tags: []string{"interest"}})
	e.create(t, transactions.New{Type: sqlc.TransactionTypeINC, AccountID: id, Amount: dec("100"), BSUConfirmed: true})
	if st := e.status(t, id); !st.Over || st.LeftYear.Sign() != 0 || st.DepositedYear.StringFixed(2) != "27600.00" {
		t.Fatalf("status after confirming %+v", st)
	}

	// A correction that adds to a deposit is checked; one that lowers it isn't.
	amount := dec("21000")
	if _, err := e.tx.Correct(ctx, e.user, inc.ID, transactions.Changes{Amount: &amount}); !errors.As(err, &over) {
		t.Errorf("correcting a deposit up: %v", err)
	}
	amount = dec("19000")
	if _, err := e.tx.Correct(ctx, e.user, inc.ID, transactions.Changes{Amount: &amount}); err != nil {
		t.Errorf("correcting a deposit down: %v", err)
	}
	// Interest that stops being interest becomes a deposit: 1 000 with 900
	// left.
	none := []string{}
	if _, err := e.tx.Correct(ctx, e.user, interest.ID, transactions.Changes{Tags: &none}); !errors.As(err, &over) {
		t.Errorf("untagging interest: %v", err)
	}
	// Moving a deposit onto the BSU is checked too.
	other := e.create(t, transactions.New{Type: sqlc.TransactionTypeINC, AccountID: e.usage, Amount: dec("5000")})
	if _, err := e.tx.Correct(ctx, e.user, other.ID, transactions.Changes{AccountID: &id}); !errors.As(err, &over) {
		t.Errorf("moving a deposit onto the BSU: %v", err)
	}
	if _, err := e.tx.Correct(ctx, e.user, other.ID, transactions.Changes{AccountID: &id, BSUConfirmed: true}); err != nil {
		t.Errorf("a confirmed move: %v", err)
	}
}

func TestWithdrawals(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	id := e.account(t, "5000")
	e.setUp(t, id)
	var w *bsu.WithdrawalError
	_, err := e.tx.Create(ctx, e.user, transactions.New{Type: sqlc.TransactionTypeEXP, AccountID: id, Amount: dec("100")})
	if !errors.As(err, &w) || w.AccountID != id {
		t.Fatalf("an expense: %v", err)
	}
	_, err = e.tx.Create(ctx, e.user, transactions.New{Type: sqlc.TransactionTypeTRF, AccountID: id, ToAccountID: e.usage, Amount: dec("100")})
	if !errors.As(err, &w) {
		t.Fatalf("a transfer out: %v", err)
	}
	exp := e.create(t, transactions.New{Type: sqlc.TransactionTypeEXP, AccountID: id, Amount: dec("100"), BSUConfirmed: true})
	if st := e.status(t, id); st.DepositedYear.Sign() != 0 {
		t.Errorf("a withdrawal lowered the deposits: %+v", st)
	}
	// Taking more out asks again; taking less doesn't.
	amount := dec("200")
	if _, err := e.tx.Correct(ctx, e.user, exp.ID, transactions.Changes{Amount: &amount}); !errors.As(err, &w) {
		t.Errorf("correcting a withdrawal up: %v", err)
	}
	amount = dec("50")
	if _, err := e.tx.Correct(ctx, e.user, exp.ID, transactions.Changes{Amount: &amount}); err != nil {
		t.Errorf("correcting a withdrawal down: %v", err)
	}
	// Money into the usage account from elsewhere isn't a BSU matter.
	e.create(t, transactions.New{Type: sqlc.TransactionTypeEXP, AccountID: e.usage, Amount: dec("10")})
}

// TestSchedulesRecord: a schedule records over the limit without asking.
func TestSchedulesRecord(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	id := e.account(t, "0")
	e.setUp(t, id)
	err := pgx.BeginFunc(ctx, e.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, e.user); err != nil {
			return err
		}
		if _, err := e.tx.RecordIn(ctx, tx, e.user, transactions.New{Type: sqlc.TransactionTypeINC, AccountID: id, Amount: dec("30000"), At: now}); err != nil {
			return err
		}
		_, err := e.tx.RecordIn(ctx, tx, e.user, transactions.New{Type: sqlc.TransactionTypeEXP, AccountID: id, Amount: dec("10"), At: now})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if st := e.status(t, id); !st.Over {
		t.Errorf("status %+v", st)
	}
}

func TestCurrencyAndType(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	if _, err := e.accounts.Create(ctx, e.user, accounts.New{Name: "Euro BSU", Type: sqlc.AccountTypeBsu, Currency: "EUR"}); !errors.Is(err, accounts.ErrBSUCurrency) {
		t.Errorf("a EUR BSU: %v", err)
	}
	eur, err := e.accounts.Create(ctx, e.user, accounts.New{Name: "Euro", Type: sqlc.AccountTypeSavings, Currency: "EUR"})
	if err != nil {
		t.Fatal(err)
	}
	typ := sqlc.AccountTypeBsu
	if _, err := e.accounts.Update(ctx, e.user, eur.ID, accounts.Changes{Type: &typ}); !errors.Is(err, accounts.ErrBSUCurrency) {
		t.Errorf("changing a EUR account to BSU: %v", err)
	}

	// A new BSU is locked; one set up is locked again after a type change
	// away and back.
	id := e.account(t, "0")
	if st := e.status(t, id); !st.Locked {
		t.Errorf("a new BSU isn't locked: %+v", st)
	}
	e.setUp(t, id)
	if st := e.status(t, id); st.Locked {
		t.Errorf("a set-up BSU is locked: %+v", st)
	}
	name := "Renamed"
	if _, err := e.accounts.Update(ctx, e.user, id, accounts.Changes{Name: &name}); err != nil || e.status(t, id).Locked {
		t.Errorf("a rename locked it: %v", err)
	}
	savings := sqlc.AccountTypeSavings
	a, err := e.accounts.Update(ctx, e.user, id, accounts.Changes{Type: &savings})
	if err != nil || a.BSU != nil {
		t.Fatalf("to savings: %v %+v", err, a.BSU)
	}
	if _, err := e.accounts.Update(ctx, e.user, id, accounts.Changes{Type: &typ}); err != nil {
		t.Fatal(err)
	}
	if st := e.status(t, id); !st.Locked {
		t.Errorf("changed back to BSU, it isn't locked: %+v", st)
	}

	// A BSU in another currency from before #214 stays locked, and can't be
	// set up.
	old := ledgertest.Account(t, e.pool, e.user, "EUR")
	if _, err := e.pool.Exec(ctx, "UPDATE bank_accounts SET account_type = 'bsu', bsu_set_up_at = now() WHERE id = $1", old); err != nil {
		t.Fatal(err)
	}
	if st := e.status(t, old); !st.Locked {
		t.Errorf("a EUR BSU isn't locked: %+v", st)
	}
	if err := e.bsu.SetUp(ctx, e.user, old, bsu.SetUpInput{}); !errors.Is(err, bsu.ErrNotBSU) {
		t.Errorf("setting up a EUR BSU: %v", err)
	}
	if _, err := e.bsu.History(ctx, e.user, e.usage); !errors.Is(err, bsu.ErrNotBSU) {
		t.Errorf("the history of a usage account: %v", err)
	}
}

// TestSetUp rebuilds an account from its real history.
func TestSetUp(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	id := e.account(t, "5000")
	// What the app has: a 2025 deposit, and this year a transfer and interest.
	e.setUp(t, id)
	e.create(t, transactions.New{Type: sqlc.TransactionTypeINC, AccountID: id, Amount: dec("10000"), At: time.Date(2025, 6, 1, 0, 0, 0, 0, time.UTC)})
	e.create(t, transactions.New{Type: sqlc.TransactionTypeTRF, AccountID: e.usage, ToAccountID: id, Amount: dec("2000"), At: now.Add(-time.Hour)})
	e.create(t, transactions.New{Type: sqlc.TransactionTypeINC, AccountID: id, Amount: dec("100"), Tags: []string{"interest"}, At: now.Add(-time.Hour)})
	if _, err := e.pool.Exec(ctx, "UPDATE bank_accounts SET bsu_set_up_at = NULL WHERE id = $1", id); err != nil {
		t.Fatal(err)
	}

	h, err := e.bsu.History(ctx, e.user, id)
	if err != nil {
		t.Fatal(err)
	}
	if h.LatestOpenedYear != 2025 || len(h.Years) != 2 || h.Opening.StringFixed(2) != "5000.00" || h.Balance.StringFixed(2) != "17100.00" ||
		h.Years[0].Recorded.Deposits.StringFixed(2) != "10000.00" || h.Years[1].Recorded.Deposits.StringFixed(2) != "2000.00" ||
		h.Years[1].Recorded.Interest.StringFixed(2) != "100.00" || len(h.Rules) != 1 || !h.SetUpAt.IsZero() {
		t.Fatalf("history %+v", h)
	}

	years := func(rows ...[4]string) []bsu.YearInput {
		var out []bsu.YearInput
		for i, r := range rows {
			out = append(out, bsu.YearInput{Year: 2023 + i, Sums: bsu.Sums{Deposits: dec(r[0]), Interest: dec(r[1]), Withdrawals: dec(r[2])}})
		}
		return out
	}
	good := bsu.SetUpInput{
		OpenedYear: 2023,
		Years: years(
			[4]string{"10000", "50", "0"},
			[4]string{"27500", "200", "1000"},
			[4]string{"15000", "300", "0"},
			[4]string{"2000", "100", "0"},
		),
		Balance: dec("54000"),
	}
	for name, in := range map[string]bsu.SetUpInput{
		"opened after the first transaction": {OpenedYear: 2026, Years: good.Years[3:], Balance: good.Balance},
		"a year missing":                     {OpenedYear: 2023, Years: good.Years[:3], Balance: good.Balance},
		"below what's recorded": {OpenedYear: 2023, Years: years(
			[4]string{"10000", "50", "0"}, [4]string{"27500", "200", "1000"}, [4]string{"9000", "300", "0"}, [4]string{"2000", "100", "0"},
		), Balance: good.Balance},
		"negative": {OpenedYear: 2023, Years: years(
			[4]string{"-1", "50", "0"}, [4]string{"27500", "200", "1000"}, [4]string{"15000", "300", "0"}, [4]string{"2000", "100", "0"},
		), Balance: good.Balance},
	} {
		if err := e.bsu.SetUp(ctx, e.user, id, in); !errors.Is(err, bsu.ErrInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if e.balance(t, id) != "17100.00" {
		t.Fatal("a refused setup changed the balance")
	}

	if err := e.bsu.SetUp(ctx, e.user, id, good); err != nil {
		t.Fatal(err)
	}
	if b := e.balance(t, id); b != "54000.00" {
		t.Errorf("balance %s, want 54000.00", b)
	}
	st := e.status(t, id)
	if st.Locked || st.OpenedYear != 2023 || st.DepositedYear.StringFixed(2) != "2000.00" || st.DepositedTotal.StringFixed(2) != "54500.00" {
		t.Errorf("status %+v", st)
	}
	h, err = e.bsu.History(ctx, e.user, id)
	if err != nil {
		t.Fatal(err)
	}
	if h.Opening.Sign() != 0 || h.SetUpAt.IsZero() || h.LatestOpenedYear != 2023 || len(h.Years) != 4 {
		t.Fatalf("history after %+v", h)
	}
	for i, y := range h.Years {
		want := good.Years[i]
		if !y.Recorded.Deposits.Equal(want.Deposits) || !y.Recorded.Interest.Equal(want.Interest) || !y.Recorded.Withdrawals.Equal(want.Withdrawals) {
			t.Errorf("%d recorded %+v, want %+v", y.Year, y.Recorded, want.Sums)
		}
	}
	// A past year's are dated 31 Dec 12:00 in Oslo, described by the year.
	var n int
	if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM transaction_headers
		WHERE user_id = $1 AND description = 'BSU history 2024' AND transaction_at = '2024-12-31 11:00:00+00'`, e.user).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Errorf("%d transactions for 2024, want 3", n)
	}
	// The balance adjustment: 54 150 recorded, 54 000 at the bank.
	if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM transaction_headers h JOIN bank_transactions b ON b.transaction_id = h.id
		WHERE h.user_id = $1 AND h.transaction_type = 'BLA' AND b.amount = -150`, e.user).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("%d balance adjustments of -150, want 1", n)
	}

	if err := e.bsu.SetUp(ctx, e.user, id, good); !errors.Is(err, bsu.ErrSetUp) {
		t.Errorf("a second setup: %v", err)
	}
}

// TestSetUpNew: a BSU opened this year with nothing before it.
func TestSetUpNew(t *testing.T) {
	e := setup(t)
	id := e.account(t, "0")
	err := e.bsu.SetUp(t.Context(), e.user, id, bsu.SetUpInput{
		OpenedYear: 2026, Years: []bsu.YearInput{{Year: 2026, Sums: bsu.Sums{Deposits: decimal.Zero, Interest: decimal.Zero, Withdrawals: decimal.Zero}}},
		Balance: decimal.Zero,
	})
	if err != nil {
		t.Fatal(err)
	}
	var n int
	if err := e.pool.QueryRow(t.Context(), "SELECT count(*) FROM bank_transactions WHERE account_id = $1", id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 || e.status(t, id).Locked {
		t.Errorf("%d lines, locked %v", n, e.status(t, id).Locked)
	}
}
