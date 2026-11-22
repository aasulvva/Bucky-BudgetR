package notifications_test

import (
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/allocation"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cycles"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/notifications"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/refill"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/savings"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/schedules"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

func dec(s string) decimal.Decimal { return decimal.RequireFromString(s) }

func at(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

var quiet = slog.New(slog.DiscardHandler)

type env struct {
	pool      *pgxpool.Pool
	now       *time.Time
	user      string
	account   string
	cycle     sqlc.Cycle
	svc       *notifications.Service
	schedules *schedules.Service
	tx        *transactions.Service
	accounts  *accounts.Service
	buckets   *buckets.Service
	cycles    *cycles.Service
}

// setup gives alice an account with 10,000 and an active October 2026 cycle
// (in UTC), on 10 October at 12:00.
func setup(t *testing.T) env {
	t.Helper()
	pool := testdb.New(t)
	now := at("2026-10-10T12:00:00Z")
	clock := func() time.Time { return now }
	l := ledger.New(ledger.Options{AfterRecord: allocation.AfterRecord})
	r := refill.NewService(pool, l, refill.Options{Now: clock})
	tx := transactions.NewService(pool, l, transactions.Options{Now: clock, Refills: r})
	e := env{
		pool: pool, now: &now, user: authtest.NewUser(t, pool, "alice").ID, tx: tx,
		schedules: schedules.NewService(pool, schedules.Options{Now: clock, Transactions: tx}),
		accounts:  accounts.NewService(pool, l, accounts.Options{Now: clock}),
		buckets:   buckets.NewService(pool, l, buckets.Options{Now: clock, OnCreate: r.OnCreate}),
		cycles:    cycles.NewService(pool, cycles.Options{Now: clock, OnEnd: r.OnEnd, OnStart: r.OnStart}),
	}
	e.svc = notifications.NewService(pool, notifications.Options{Now: clock, Schedules: e.schedules, Buckets: e.buckets})
	var err error
	if e.cycle, err = e.cycles.Create(t.Context(), e.user, at("2026-10-01T00:00:00Z"), at("2026-11-01T00:00:00Z")); err != nil {
		t.Fatal(err)
	}
	if _, err := e.cycles.Start(t.Context(), e.user, e.cycle.ID); err != nil {
		t.Fatal(err)
	}
	e.account = e.newAccount(t, "Main", sqlc.AccountTypeUsage, "10000")
	return e
}

func (e env) newAccount(t *testing.T, name string, typ sqlc.AccountType, opening string) string {
	t.Helper()
	a, err := e.accounts.Create(t.Context(), e.user, accounts.New{Name: name, Type: typ, OpeningBalance: dec(opening)})
	if err != nil {
		t.Fatal(err)
	}
	return a.ID
}

// made dates an account's creation, as if made then.
func (e env) made(t *testing.T, id, when string) {
	t.Helper()
	if _, err := e.pool.Exec(t.Context(), `UPDATE bank_accounts SET created_at = $2 WHERE id = $1`, id, at(when)); err != nil {
		t.Fatal(err)
	}
}

// prefer sets the user's notifications preference.
func (e env) prefer(t *testing.T, settings string) {
	t.Helper()
	if _, err := e.pool.Exec(t.Context(),
		`UPDATE users SET preferences = preferences || jsonb_build_object('notifications', $2::jsonb) WHERE id = $1`,
		e.user, settings); err != nil {
		t.Fatal(err)
	}
}

func (e env) list(t *testing.T) []notifications.Notification {
	t.Helper()
	out, err := e.svc.List(t.Context(), e.user)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func (e env) dismiss(t *testing.T, key string) {
	t.Helper()
	if err := e.svc.Dismiss(t.Context(), e.user, key); err != nil {
		t.Fatal(err)
	}
}

func (e env) dismissals(t *testing.T) int {
	t.Helper()
	var n int
	if err := e.pool.QueryRow(t.Context(), `SELECT count(*) FROM notification_dismissals WHERE user_id = $1`, e.user).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func (e env) schedule(t *testing.T, s schedules.Settings) schedules.Schedule {
	t.Helper()
	out, err := e.schedules.Create(t.Context(), e.user, s)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// daily is a daily schedule at 12:00 UTC from start.
func (e env) daily(typ sqlc.TransactionType, mode sqlc.ScheduleMode, start string) schedules.Settings {
	return schedules.Settings{
		Transaction: transactions.New{Type: typ, AccountID: e.account, Amount: dec("100"), Counterparty: "Rent"},
		Mode:        mode, Start: at(start + "T00:00:00Z"), Minute: 12 * 60, TimeZone: "UTC",
		Frequency: sqlc.ScheduleFrequencyDay, Every: 1,
	}
}

func (e env) run(t *testing.T, to string) {
	t.Helper()
	*e.now = at(to)
	if err := e.schedules.RunDue(t.Context(), quiet); err != nil {
		t.Fatal(err)
	}
}

func kinds(list []notifications.Notification) []notifications.Kind {
	out := make([]notifications.Kind, len(list))
	for i, n := range list {
		out[i] = n.Kind
	}
	return out
}

func TestQueue(t *testing.T) {
	e := setup(t)
	// An income asking first, so no bills.
	e.schedule(t, e.daily(sqlc.TransactionTypeINC, sqlc.ScheduleModeApprove, "2026-10-11"))
	if got := e.list(t); len(got) != 0 {
		t.Fatalf("before anything is queued = %v", kinds(got))
	}
	e.run(t, "2026-10-11T12:00:00Z")
	got := e.list(t)
	if len(got) != 1 || got[0].Kind != notifications.KindQueue || got[0].Count != 1 || got[0].Overdue != 0 ||
		got[0].Severity != notifications.Warning {
		t.Fatalf("queued = %+v", got)
	}
	first := got[0].Key

	// Overdue once its time has passed.
	*e.now = at("2026-10-11T13:00:00Z")
	got = e.list(t)
	if got[0].Overdue != 1 || got[0].Severity != notifications.Alert || got[0].Key != first {
		t.Fatalf("overdue = %+v", got[0])
	}

	// Dismissed, it stays hidden until another one is queued.
	e.dismiss(t, first)
	if got := e.list(t); len(got) != 0 {
		t.Fatalf("dismissed = %v", kinds(got))
	}
	e.run(t, "2026-10-12T12:00:00Z")
	got = e.list(t)
	if len(got) != 1 || got[0].Count != 2 || got[0].Key == first {
		t.Fatalf("after another = %+v", got)
	}
	if n := e.dismissals(t); n != 0 {
		t.Errorf("the old dismissal is kept: %d", n)
	}

	// Approving them clears it.
	queued, err := e.schedules.Occurrences(t.Context(), e.user, schedules.Filter{State: sqlc.OccurrenceStateQueued})
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range queued.Items {
		if _, _, err := e.schedules.Approve(t.Context(), e.user, o.ID, nil); err != nil {
			t.Fatal(err)
		}
	}
	if got := e.list(t); len(got) != 0 {
		t.Fatalf("approved = %v", kinds(got))
	}
}

func TestBills(t *testing.T) {
	e := setup(t)
	rent := e.schedule(t, e.daily(sqlc.TransactionTypeEXP, sqlc.ScheduleModeAuto, "2026-10-11"))
	e.schedule(t, e.daily(sqlc.TransactionTypeINC, sqlc.ScheduleModeAuto, "2026-10-11"))
	paused := e.daily(sqlc.TransactionTypeEXP, sqlc.ScheduleModeAuto, "2026-10-11")
	paused.Paused = true
	e.schedule(t, paused)

	// Three days ahead: 11 and 12 October (13 October at 12:00 is the end).
	got := e.list(t)
	if len(got) != 2 {
		t.Fatalf("bills = %+v", got)
	}
	for i, want := range []string{"2026-10-11T12:00:00Z", "2026-10-12T12:00:00Z"} {
		n := got[i]
		if n.Kind != notifications.KindBill || n.ScheduleID != rent.ID || !n.At.Equal(at(want)) ||
			!n.Amount.Decimal.Equal(dec("100")) || n.Currency != "NOK" || n.AccountID != e.account {
			t.Errorf("bill %d = %+v, want at %s", i, n, want)
		}
	}

	e.prefer(t, `{"upcoming_days": 2}`)
	if got := e.list(t); len(got) != 1 {
		t.Fatalf("two days ahead = %d", len(got))
	}
	e.prefer(t, `{"upcoming_bills": false}`)
	if got := e.list(t); len(got) != 0 {
		t.Fatalf("switched off = %d", len(got))
	}
	e.prefer(t, `{}`)

	// A dismissed bill is forgotten once it's past.
	e.dismiss(t, got[0].Key)
	if got := e.list(t); len(got) != 1 || !got[0].At.Equal(at("2026-10-12T12:00:00Z")) {
		t.Fatalf("dismissed = %+v", got)
	}
	e.run(t, "2026-10-11T12:00:00Z")
	if got := e.list(t); len(got) != 2 || !got[0].At.Equal(at("2026-10-12T12:00:00Z")) {
		t.Fatalf("a day later = %+v", got)
	}
	if n := e.dismissals(t); n != 0 {
		t.Errorf("the past bill's dismissal is kept: %d", n)
	}
}

func TestBalances(t *testing.T) {
	e := setup(t)
	invest := e.newAccount(t, "Shares", sqlc.AccountTypeInvestment, "5000")
	fund := e.newAccount(t, "Fund", sqlc.AccountTypeFund, "2000")
	e.newAccount(t, "New shares", sqlc.AccountTypeInvestment, "1000") // made in this cycle
	e.made(t, invest, "2026-09-01T00:00:00Z")
	e.made(t, fund, "2026-09-01T00:00:00Z")

	got := e.list(t)
	if len(got) != 2 {
		t.Fatalf("balances = %+v", got)
	}
	for _, n := range got {
		if n.Kind != notifications.KindBalance || n.CycleID != e.cycle.ID || !n.At.Equal(e.cycle.StartAt) {
			t.Errorf("balance = %+v", n)
		}
	}

	// Adjusting the balance clears it; "the balance is right" dismisses it.
	if _, err := e.accounts.AdjustBalance(t.Context(), e.user, invest, accounts.Adjustment{Target: dec("5200")}); err != nil {
		t.Fatal(err)
	}
	got = e.list(t)
	if len(got) != 1 || got[0].AccountID != fund {
		t.Fatalf("after adjusting = %+v", got)
	}
	e.dismiss(t, got[0].Key)
	if got := e.list(t); len(got) != 0 {
		t.Fatalf("done = %+v", got)
	}

	// The next cycle asks again.
	next, err := e.cycles.Create(t.Context(), e.user, at("2026-11-01T00:00:00Z"), at("2026-12-01T00:00:00Z"))
	if err != nil {
		t.Fatal(err)
	}
	*e.now = at("2026-11-01T08:00:00Z")
	if _, err := e.cycles.End(t.Context(), e.user, e.cycle.ID, true); err != nil {
		t.Fatal(err)
	}
	got = e.list(t)
	if len(got) != 3 {
		t.Fatalf("next cycle = %+v", got)
	}
	for _, n := range got {
		if n.CycleID != next.ID {
			t.Errorf("next cycle = %+v", n)
		}
	}
	if n := e.dismissals(t); n != 0 {
		t.Errorf("last cycle's dismissal is kept: %d", n)
	}
}

func TestUncovered(t *testing.T) {
	e := setup(t)
	pri, err := e.buckets.Create(t.Context(), e.user, buckets.New{
		Name: "Rent", SourceAccountID: e.account, RefillAmount: dec("1000"), CapMultiplier: dec("1"),
		Priority: true, Refill: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.buckets.Create(t.Context(), e.user, buckets.New{
		Name: "Fun", SourceAccountID: e.account, RefillAmount: dec("1000"), CapMultiplier: dec("1"), Refill: true,
	}); err != nil {
		t.Fatal(err)
	}
	if got := e.list(t); len(got) != 0 {
		t.Fatalf("covered = %+v", got)
	}

	spend := func(amount string) {
		t.Helper()
		if _, err := e.tx.Create(t.Context(), e.user, transactions.New{Type: sqlc.TransactionTypeEXP, AccountID: e.account, Amount: dec(amount)}); err != nil {
			t.Fatal(err)
		}
	}
	spend("9600") // 400 left for 2,000 of TF
	got := e.list(t)
	if len(got) != 1 || got[0].Kind != notifications.KindBucket || got[0].BucketID != pri.ID ||
		!got[0].Amount.Decimal.Equal(dec("600")) || got[0].Severity != notifications.Alert {
		t.Fatalf("uncovered = %+v", got)
	}

	// Dismissed, it comes back after being covered and uncovered again.
	e.dismiss(t, got[0].Key)
	if got := e.list(t); len(got) != 0 {
		t.Fatalf("dismissed = %+v", got)
	}
	if _, err := e.tx.Create(t.Context(), e.user, transactions.New{Type: sqlc.TransactionTypeINC, AccountID: e.account, Amount: dec("2000")}); err != nil {
		t.Fatal(err)
	}
	if got := e.list(t); len(got) != 0 {
		t.Fatalf("covered again = %+v", got)
	}
	spend("2000")
	if got := e.list(t); len(got) != 1 || got[0].BucketID != pri.ID {
		t.Fatalf("uncovered again = %+v", got)
	}

	// A kind switched off keeps its dismissals.
	e.dismiss(t, got[0].Key)
	e.prefer(t, `{"bucket_uncovered": false}`)
	if got := e.list(t); len(got) != 0 || e.dismissals(t) != 1 {
		t.Fatalf("switched off = %+v, %d dismissals", got, e.dismissals(t))
	}
}

func TestDismissUnknown(t *testing.T) {
	e := setup(t)
	err := e.svc.Dismiss(t.Context(), e.user, "bucket:1234567890")
	if !errors.Is(err, notifications.ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
	// Another user's aren't theirs.
	e.schedule(t, e.daily(sqlc.TransactionTypeEXP, sqlc.ScheduleModeAuto, "2026-10-11"))
	bob := authtest.NewUser(t, e.pool, "bob").ID
	got := e.list(t)
	if len(got) == 0 {
		t.Fatal("no bills")
	}
	if list, err := e.svc.List(t.Context(), bob); err != nil || len(list) != 0 {
		t.Fatalf("bob's = %+v, %v", list, err)
	}
	if err := e.svc.Dismiss(t.Context(), bob, got[0].Key); !errors.Is(err, notifications.ErrNotFound) {
		t.Fatalf("bob dismissing = %v", err)
	}
}

// TestSavingsTransfer: one per savings target with money held for it (#231),
// shown again after a dismissal once more is held or some is moved.
func TestSavingsTransfer(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	clock := func() time.Time { return *e.now }
	sv := savings.NewService(e.pool, ledger.New(ledger.Options{AfterRecord: allocation.AfterRecord}), savings.Options{Now: clock})
	e.svc = notifications.NewService(e.pool, notifications.Options{Now: clock, Savings: sv})
	buffer := e.newAccount(t, "Buffer", sqlc.AccountTypeSavings, "0")
	target, err := sv.Create(ctx, e.user, savings.New{AccountID: buffer, Goal: dec("5000")})
	if err != nil {
		t.Fatal(err)
	}
	held := func() []notifications.Notification {
		t.Helper()
		var out []notifications.Notification
		for _, n := range e.list(t) {
			if n.Kind == notifications.KindSavings {
				out = append(out, n)
			}
		}
		return out
	}
	if got := held(); len(got) != 0 {
		t.Fatalf("nothing held: %+v", got)
	}

	if _, err := sv.Add(ctx, e.user, target.ID, e.account, dec("300")); err != nil {
		t.Fatal(err)
	}
	got := held()
	if len(got) != 1 || got[0].TargetID != target.ID || got[0].Amount.Decimal.StringFixed(2) != "300.00" ||
		got[0].Currency != "NOK" || got[0].Severity != notifications.Info {
		t.Fatalf("held: %+v", got)
	}
	e.dismiss(t, got[0].Key)
	if got := held(); len(got) != 0 {
		t.Errorf("dismissed: %+v", got)
	}
	// Moving some of it shows it again, with what's left.
	if _, err := sv.Done(ctx, e.user, target.ID, savings.Done{AccountID: e.account, Amount: dec("100")}); err != nil {
		t.Fatal(err)
	}
	if got := held(); len(got) != 1 || got[0].Amount.Decimal.StringFixed(2) != "200.00" {
		t.Errorf("after Done: %+v", got)
	}
	e.prefer(t, `{"savings_transfer": false}`)
	if got := held(); len(got) != 0 {
		t.Errorf("switched off: %+v", got)
	}
	e.prefer(t, `{}`)
	if _, err := sv.Done(ctx, e.user, target.ID, savings.Done{AccountID: e.account, Amount: dec("200")}); err != nil {
		t.Fatal(err)
	}
	if got := held(); len(got) != 0 {
		t.Errorf("all moved: %+v", got)
	}
}
