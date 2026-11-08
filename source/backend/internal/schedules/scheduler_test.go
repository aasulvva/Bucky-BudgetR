package schedules_test

import (
	"errors"
	"fmt"
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
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledgertest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/refill"
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

func date(s string) time.Time { return at(s + "T00:00:00Z") }

var quiet = slog.New(slog.DiscardHandler)

type env struct {
	pool    *pgxpool.Pool
	now     *time.Time
	user    string
	account string
	svc     *schedules.Service
	tx      *transactions.Service
	buckets *buckets.Service
	cycle   sqlc.Cycle
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
		svc:     schedules.NewService(pool, schedules.Options{Now: clock, Transactions: tx}),
		buckets: buckets.NewService(pool, l, buckets.Options{Now: clock}),
	}
	cy := cycles.NewService(pool, cycles.Options{Now: clock, OnEnd: r.OnEnd, OnStart: r.OnStart})
	var err error
	if e.cycle, err = cy.Create(t.Context(), e.user, at("2026-10-01T00:00:00Z"), at("2026-11-01T00:00:00Z")); err != nil {
		t.Fatal(err)
	}
	if _, err := cy.Start(t.Context(), e.user, e.cycle.ID); err != nil {
		t.Fatal(err)
	}
	a, err := accounts.NewService(pool, l, accounts.Options{Now: clock}).Create(t.Context(), e.user, accounts.New{Name: "Main", OpeningBalance: dec("10000")})
	if err != nil {
		t.Fatal(err)
	}
	e.account = a.ID
	return e
}

func (e env) bucket(t *testing.T, mode sqlc.RefillMode) string {
	t.Helper()
	b, err := e.buckets.Create(t.Context(), e.user, buckets.New{
		Name: fmt.Sprintf("B%d", time.Now().UnixNano()), SourceAccountID: e.account, RefillAmount: dec("100"),
		CapMultiplier: dec("1.5"), RefillMode: mode,
	})
	if err != nil {
		t.Fatal(err)
	}
	return b.ID
}

// daily is a daily auto expense of 100 from the account at 12:00 UTC.
func (e env) daily(start string) schedules.Settings {
	return schedules.Settings{
		Transaction: transactions.New{Type: sqlc.TransactionTypeEXP, AccountID: e.account, Amount: dec("100"), Counterparty: "Rent"},
		Mode:        sqlc.ScheduleModeAuto, DueDays: 3, Start: date(start), Minute: 12 * 60, TimeZone: "UTC",
		Frequency: sqlc.ScheduleFrequencyDay, Every: 1,
	}
}

func (e env) create(t *testing.T, s schedules.Settings) schedules.Schedule {
	t.Helper()
	out, err := e.svc.Create(t.Context(), e.user, s)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func (e env) run(t *testing.T, to string) {
	t.Helper()
	*e.now = at(to)
	if err := e.svc.RunDue(t.Context(), quiet); err != nil {
		t.Fatal(err)
	}
}

// occurrences returns the schedule's occurrences, oldest first, as
// "time state reason".
func (e env) occurrences(t *testing.T, id string) []string {
	t.Helper()
	page, err := e.svc.Occurrences(t.Context(), e.user, schedules.Filter{ScheduleID: id})
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for i := len(page.Items) - 1; i >= 0; i-- {
		o := page.Items[i]
		s := o.ScheduledAt.UTC().Format("01-02 15:04") + " " + string(o.State)
		if o.Reason != "" {
			s += " " + string(o.Reason)
		}
		out = append(out, s)
	}
	return out
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestCreate(t *testing.T) {
	e := setup(t)
	// Monthly from the 31st of August: the next is 31 October.
	s := e.daily("2026-08-31")
	s.Frequency, s.Name = sqlc.ScheduleFrequencyMonth, "  Rent  "
	got := e.create(t, s)
	if got.Name != "Rent" || got.NextIndex != 2 || !got.NextAt.Equal(at("2026-10-31T12:00:00Z")) {
		t.Errorf("created %+v", got)
	}
	up, err := e.svc.Upcoming(t.Context(), e.user, got.ID, 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(up) != 3 || !up[1].Equal(at("2026-11-30T12:00:00Z")) {
		t.Errorf("upcoming %v", up)
	}

	// Without a time zone, the user's preference, else UTC.
	s = e.daily("2026-10-11")
	s.TimeZone = ""
	if got := e.create(t, s); got.TimeZone != "UTC" {
		t.Errorf("default time zone %q", got.TimeZone)
	}
	if _, err := e.pool.Exec(t.Context(), `UPDATE users SET preferences = '{"time_zone": "Europe/Oslo"}' WHERE id = $1`, e.user); err != nil {
		t.Fatal(err)
	}
	if got := e.create(t, s); got.TimeZone != "Europe/Oslo" || !got.NextAt.Equal(at("2026-10-11T10:00:00Z")) {
		t.Errorf("Oslo %q %v", got.TimeZone, got.NextAt)
	}

	other := ledgertest.Account(t, e.pool, authtest.NewUser(t, e.pool, "bob").ID, "NOK")
	for name, change := range map[string]func(*schedules.Settings){
		"passed":           func(s *schedules.Settings) { s.Frequency, s.Start = sqlc.ScheduleFrequencyOnce, date("2026-10-01") },
		"ended":            func(s *schedules.Settings) { s.EndDate = date("2026-10-09") },
		"count and date":   func(s *schedules.Settings) { s.EndCount, s.EndDate = 3, date("2027-01-01") },
		"end before start": func(s *schedules.Settings) { s.EndDate = date("2026-07-01") },
		"every 0":          func(s *schedules.Settings) { s.Every = 0 },
		"time of day":      func(s *schedules.Settings) { s.Minute = 24 * 60 },
		"time zone":        func(s *schedules.Settings) { s.TimeZone = "Mars/Olympus" },
		"due days":         func(s *schedules.Settings) { s.DueDays = 61 },
		"mode":             func(s *schedules.Settings) { s.Mode = "sometimes" },
		"bob's account":    func(s *schedules.Settings) { s.Transaction.AccountID = other },
		"TRF with no to":   func(s *schedules.Settings) { s.Transaction.Type = sqlc.TransactionTypeTRF },
		"system type":      func(s *schedules.Settings) { s.Transaction.Type = sqlc.TransactionTypeREF },
		"no amount":        func(s *schedules.Settings) { s.Transaction.Amount = decimal.Zero },
		"long tag":         func(s *schedules.Settings) { s.Transaction.Tags = []string{string(make([]byte, 51))} },
	} {
		s := e.daily("2026-08-01")
		change(&s)
		_, err := e.svc.Create(t.Context(), e.user, s)
		if !errors.Is(err, schedules.ErrInvalid) && !errors.Is(err, transactions.ErrInvalid) && !errors.Is(err, ledger.ErrInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// A first time that has just passed (this minute, by the time it's saved) is
// left to the scheduler; an older one isn't handled.
func TestCreateJustPassed(t *testing.T) {
	e := setup(t)
	minutesAgo := func(n int, mode sqlc.ScheduleMode, freq sqlc.ScheduleFrequency) schedules.Schedule {
		t.Helper()
		s := e.daily("2026-10-10")
		s.Minute, s.Mode, s.Frequency = 12*60-n, mode, freq
		return e.create(t, s)
	}
	auto := minutesAgo(30, sqlc.ScheduleModeAuto, sqlc.ScheduleFrequencyDay)
	if auto.NextIndex != 0 || !auto.NextAt.Equal(at("2026-10-10T11:30:00Z")) {
		t.Errorf("30 minutes ago: next %d at %v", auto.NextIndex, auto.NextAt)
	}
	ask := minutesAgo(1, sqlc.ScheduleModeApprove, sqlc.ScheduleFrequencyOnce)
	if ask.NextIndex != 0 || !ask.NextAt.Equal(at("2026-10-10T11:59:00Z")) {
		t.Errorf("once, a minute ago: next %d at %v", ask.NextIndex, ask.NextAt)
	}
	old := minutesAgo(61, sqlc.ScheduleModeAuto, sqlc.ScheduleFrequencyDay)
	if old.NextIndex != 1 || !old.NextAt.Equal(at("2026-10-11T10:59:00Z")) {
		t.Errorf("61 minutes ago: next %d at %v", old.NextIndex, old.NextAt)
	}

	e.run(t, "2026-10-10T12:00:30Z")
	if got := e.occurrences(t, auto.ID); !equal(got, []string{"10-10 11:30 applied"}) {
		t.Errorf("auto: %v", got)
	}
	if got := e.occurrences(t, ask.ID); !equal(got, []string{"10-10 11:59 queued approval"}) {
		t.Errorf("asking first: %v", got)
	}
	if got := e.occurrences(t, old.ID); len(got) != 0 {
		t.Errorf("61 minutes ago: %v", got)
	}
}

func TestRunAuto(t *testing.T) {
	e := setup(t)
	onIncome := e.bucket(t, sqlc.RefillModeOnIncome)
	yes := true
	s := e.daily("2026-10-10")
	s.Transaction = transactions.New{
		Type: sqlc.TransactionTypeINC, AccountID: e.account, Amount: dec("1000"), Counterparty: "Salary", Tags: []string{"pay"},
		Description: " Monthly pay\r\nbefore tax \n",
		Buckets:     []transactions.BucketAmount{{BucketID: onIncome, Amount: dec("50")}}, TriggersRefill: &yes,
	}
	s.EndCount = 3
	// Today's 12:00 is now, so it's the first.
	sch := e.create(t, s)
	if sch.NextIndex != 0 {
		t.Fatalf("next %d", sch.NextIndex)
	}
	// The description is stored as the ledger will store it (#130).
	if sch.Transaction.Description != "Monthly pay\nbefore tax" {
		t.Errorf("schedule description %q", sch.Transaction.Description)
	}
	e.run(t, "2026-10-10T12:00:00Z")
	e.run(t, "2026-10-10T12:00:30Z") // again: nothing new
	if got := e.occurrences(t, sch.ID); !equal(got, []string{"10-10 12:00 applied"}) {
		t.Fatalf("occurrences %v", got)
	}
	page, err := e.svc.Occurrences(t.Context(), e.user, schedules.Filter{State: sqlc.OccurrenceStateApplied})
	if err != nil {
		t.Fatal(err)
	}
	tr, err := e.tx.Get(t.Context(), e.user, page.Items[0].TransactionID)
	if err != nil {
		t.Fatal(err)
	}
	if !tr.At.Equal(at("2026-10-10T12:00:00Z")) || tr.Counterparty != "Salary" || tr.Description != "Monthly pay\nbefore tax" || len(tr.Tags) != 1 || !tr.TriggersRefill ||
		len(tr.BucketLines) != 1 || tr.BucketLines[0].CycleID != e.cycle.ID || tr.CreatedBy != e.user {
		t.Errorf("transaction %+v", tr)
	}
	var refills int
	if err := e.pool.QueryRow(t.Context(), `SELECT count(*) FROM refills WHERE bucket_id = $1 AND income_id = $2`, onIncome, tr.ID).Scan(&refills); err != nil {
		t.Fatal(err)
	}
	if refills != 1 {
		t.Errorf("the income didn't refill its bucket")
	}

	// Two days later: both are caught up, and it ends after the third.
	e.run(t, "2026-10-13T00:00:00Z")
	if got := e.occurrences(t, sch.ID); !equal(got, []string{"10-10 12:00 applied", "10-11 12:00 applied", "10-12 12:00 applied"}) {
		t.Errorf("occurrences %v", got)
	}
	if sch, err = e.svc.Get(t.Context(), e.user, sch.ID); err != nil || sch.NextIndex != 3 || !sch.NextAt.IsZero() {
		t.Errorf("ended %+v %v", sch, err)
	}
}

func TestRunQueued(t *testing.T) {
	e := setup(t)
	groceries := e.bucket(t, sqlc.RefillModeAuto)
	withBucket := func(s schedules.Settings) schedules.Settings {
		s.Transaction.Buckets = []transactions.BucketAmount{{BucketID: groceries, Amount: dec("60")}}
		return s
	}

	approve := withBucket(e.daily("2026-10-11"))
	approve.Mode, approve.DueDays = sqlc.ScheduleModeApprove, 5
	a := e.create(t, approve)
	// Across the cycle's end (which it is not ended at): in the cycle
	// applied, after it queued.
	b := e.create(t, withBucket(e.daily("2026-10-30")))
	// A bucket that's deleted before it's due.
	gone := e.bucket(t, sqlc.RefillModeAuto)
	c := withBucket(e.daily("2026-10-11"))
	c.Transaction.Buckets[0].BucketID = gone
	c.Frequency = sqlc.ScheduleFrequencyOnce
	cs := e.create(t, c)
	ledgertest.Delete(t, e.pool, "buckets", gone)
	// Paused, it's left alone.
	p := e.daily("2026-10-11")
	p.Paused = true
	ps := e.create(t, p)
	// Without bucket lines, it needs no cycle.
	plain := e.create(t, e.daily("2026-11-02"))

	e.run(t, "2026-10-11T12:00:00Z")
	// Asking first, they're queued five days ahead, each due at its time.
	if got := e.occurrences(t, a.ID); len(got) != 6 || got[5] != "10-16 12:00 queued approval" {
		t.Errorf("approval %v", got)
	}
	page, err := e.svc.Occurrences(t.Context(), e.user, schedules.Filter{ScheduleID: a.ID})
	if err != nil {
		t.Fatal(err)
	}
	if o := page.Items[0]; o.State != sqlc.OccurrenceStateQueued || o.Reason != sqlc.OccurrenceReasonApproval ||
		!o.DueAt.Equal(at("2026-10-16T12:00:00Z")) || o.TransactionID != "" || o.Overdue {
		t.Errorf("approval %+v", o)
	}
	if o := page.Items[5]; !o.DueAt.Equal(at("2026-10-11T12:00:00Z")) || o.Overdue {
		t.Errorf("approval due now %+v", o)
	}
	if got := e.occurrences(t, cs.ID); len(got) != 1 || got[0] != "10-11 12:00 queued invalid" {
		t.Errorf("deleted bucket %v", got)
	}

	e.run(t, "2026-11-02T13:00:00Z")
	if got := e.occurrences(t, b.ID); !equal(got, []string{
		"10-30 12:00 applied", "10-31 12:00 applied", "11-01 12:00 queued outside_cycle", "11-02 12:00 queued outside_cycle",
	}) {
		t.Errorf("across the end %v", got)
	}
	if got := e.occurrences(t, plain.ID); !equal(got, []string{"11-02 12:00 applied"}) {
		t.Errorf("no buckets %v", got)
	}
	if got := e.occurrences(t, ps.ID); len(got) != 0 {
		t.Errorf("paused %v", got)
	}

	// Resumed, it starts from now.
	p.Paused = false
	if ps, err = e.svc.Update(t.Context(), e.user, ps.ID, p); err != nil || !ps.NextAt.Equal(at("2026-11-03T12:00:00Z")) {
		t.Errorf("resumed %+v %v", ps, err)
	}

	// No active cycle.
	if _, err := e.pool.Exec(t.Context(), `UPDATE cycles SET state = 'finished' WHERE id = $1`, e.cycle.ID); err != nil {
		t.Fatal(err)
	}
	e.run(t, "2026-11-03T12:00:00Z")
	if got := e.occurrences(t, b.ID); got[len(got)-1] != "11-03 12:00 queued no_active_cycle" {
		t.Errorf("no cycle %v", got)
	}

	// Deleting a schedule keeps its transactions.
	page, err = e.svc.Occurrences(t.Context(), e.user, schedules.Filter{ScheduleID: b.ID, State: sqlc.OccurrenceStateApplied})
	if err != nil || len(page.Items) != 2 {
		t.Fatalf("applied %v %v", page, err)
	}
	if err := e.svc.Delete(t.Context(), e.user, b.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.tx.Get(t.Context(), e.user, page.Items[0].TransactionID); err != nil {
		t.Errorf("transaction gone: %v", err)
	}
	if got := e.occurrences(t, b.ID); len(got) != 0 {
		t.Errorf("occurrences left %v", got)
	}
	if err := e.svc.Delete(t.Context(), e.user, b.ID); !errors.Is(err, schedules.ErrNotFound) {
		t.Errorf("delete again %v", err)
	}
}

func TestOccurrencesPages(t *testing.T) {
	e := setup(t)
	s := e.daily("2026-10-10")
	s.Mode = sqlc.ScheduleModeApprove
	sch := e.create(t, s)
	e.run(t, "2026-10-14T12:00:00Z")
	var seen []string
	cursor := ""
	for range 5 {
		page, err := e.svc.Occurrences(t.Context(), e.user, schedules.Filter{Limit: 2, Cursor: cursor, State: sqlc.OccurrenceStateQueued})
		if err != nil {
			t.Fatal(err)
		}
		for _, o := range page.Items {
			seen = append(seen, o.ScheduledAt.UTC().Format("01-02"))
		}
		if cursor = page.Next; cursor == "" {
			break
		}
	}
	// Asking first, they're queued three days ahead.
	if !equal(seen, []string{"10-17", "10-16", "10-15", "10-14", "10-13", "10-12", "10-11", "10-10"}) {
		t.Errorf("pages %v", seen)
	}
	if _, err := e.svc.Occurrences(t.Context(), e.user, schedules.Filter{Cursor: "nope"}); !errors.Is(err, schedules.ErrInvalid) {
		t.Errorf("bad cursor %v", err)
	}
	if page, err := e.svc.Occurrences(t.Context(), authtest.NewUser(t, e.pool, "bob").ID, schedules.Filter{ScheduleID: sch.ID}); err != nil || len(page.Items) != 0 {
		t.Errorf("bob sees %v %v", page, err)
	}
}

func TestCreateRecordingFirst(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	recordFirst := func(s schedules.Settings) schedules.Schedule {
		t.Helper()
		out, err := e.svc.CreateRecordingFirst(ctx, e.user, s)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	// The recorded transaction of a schedule's only occurrence.
	recorded := func(id string) transactions.Transaction {
		t.Helper()
		page, err := e.svc.Occurrences(ctx, e.user, schedules.Filter{ScheduleID: id})
		if err != nil || len(page.Items) != 1 || page.Items[0].TransactionID == "" {
			t.Fatalf("occurrences %+v, %v", page.Items, err)
		}
		tx, err := e.tx.Get(ctx, e.user, page.Items[0].TransactionID)
		if err != nil {
			t.Fatal(err)
		}
		if tx.ScheduleID != id {
			t.Errorf("schedule of the transaction: %q, want %q", tx.ScheduleID, id)
		}
		return tx
	}

	// Two days ago: recorded, dated then, and goes on from today's, which is
	// now.
	sch := recordFirst(e.daily("2026-10-08"))
	if sch.NextIndex != 2 || !sch.NextAt.Equal(at("2026-10-10T12:00:00Z")) {
		t.Errorf("two days ago: next %d at %v", sch.NextIndex, sch.NextAt)
	}
	if tx := recorded(sch.ID); !tx.At.Equal(at("2026-10-08T12:00:00Z")) || tx.Counterparty != "Rent" {
		t.Errorf("two days ago: recorded %+v", tx)
	}
	// The scheduler then records today's, and doesn't record the first again.
	e.run(t, "2026-10-10T12:00:00Z")
	if got := e.occurrences(t, sch.ID); !equal(got, []string{"10-08 12:00 applied", "10-10 12:00 applied"}) {
		t.Errorf("after a run: %v", got)
	}

	// Asking first: recorded too, as it's entered as done. The scheduler
	// then queues the next ones three days ahead.
	s := e.daily("2026-10-08")
	s.Mode = sqlc.ScheduleModeApprove
	sch = recordFirst(s)
	if sch.NextIndex != 2 || !sch.NextAt.Equal(at("2026-10-10T12:00:00Z")) {
		t.Errorf("asking first: next %d at %v", sch.NextIndex, sch.NextAt)
	}
	recorded(sch.ID)
	e.run(t, "2026-10-10T12:00:00Z")
	if got := e.occurrences(t, sch.ID); !equal(got, []string{
		"10-08 12:00 applied", "10-10 12:00 queued approval", "10-11 12:00 queued approval",
		"10-12 12:00 queued approval", "10-13 12:00 queued approval",
	}) {
		t.Errorf("asking first, after a run: %v", got)
	}

	// Now: recorded, and goes on from tomorrow.
	sch = recordFirst(e.daily("2026-10-10"))
	if sch.NextIndex != 1 || !sch.NextAt.Equal(at("2026-10-11T12:00:00Z")) {
		t.Errorf("now: next %d at %v", sch.NextIndex, sch.NextAt)
	}
	recorded(sch.ID)

	// Once, in the past: recorded, and ended.
	s = e.daily("2026-10-09")
	s.Frequency = sqlc.ScheduleFrequencyOnce
	sch = recordFirst(s)
	if sch.NextIndex != 1 || !sch.NextAt.IsZero() {
		t.Errorf("once: next %d at %v", sch.NextIndex, sch.NextAt)
	}
	recorded(sch.ID)

	// In the future: left to the schedule.
	sch = recordFirst(e.daily("2026-10-12"))
	if sch.NextIndex != 0 || !sch.NextAt.Equal(at("2026-10-12T12:00:00Z")) || len(e.occurrences(t, sch.ID)) != 0 {
		t.Errorf("future: next %d at %v", sch.NextIndex, sch.NextAt)
	}

	// Outside the cycle, with a bucket line: nothing is saved.
	before, err := e.svc.List(ctx, e.user)
	if err != nil {
		t.Fatal(err)
	}
	s = e.daily("2026-09-20")
	s.Transaction.Buckets = []transactions.BucketAmount{{BucketID: e.bucket(t, sqlc.RefillModeManual), Amount: dec("50")}}
	if _, err := e.svc.CreateRecordingFirst(ctx, e.user, s); !errors.Is(err, ledger.ErrOutsideCycle) {
		t.Errorf("outside the cycle: %v", err)
	}
	if after, err := e.svc.List(ctx, e.user); err != nil || len(after) != len(before) {
		t.Errorf("outside the cycle saved a schedule: %d, %v", len(after), err)
	}

	// Plain Create doesn't record a first that passed more than an hour ago.
	sch = e.create(t, e.daily("2026-10-08"))
	if sch.NextIndex != 2 || len(e.occurrences(t, sch.ID)) != 0 {
		t.Errorf("create: next %d", sch.NextIndex)
	}
}

func TestPreview(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	s := schedules.Settings{Start: date("2026-08-31"), Minute: 8 * 60, Frequency: sqlc.ScheduleFrequencyMonth, Every: 1}
	got, err := e.svc.Preview(ctx, e.user, s, 3)
	if err != nil {
		t.Fatal(err)
	}
	want := []time.Time{at("2026-10-31T08:00:00Z"), at("2026-11-30T08:00:00Z"), at("2026-12-31T08:00:00Z")}
	if len(got) != 3 || !got[0].Equal(want[0]) || !got[1].Equal(want[1]) || !got[2].Equal(want[2]) {
		t.Errorf("monthly from the 31st: %v", got)
	}
	s.EndCount = 3
	if got, err := e.svc.Preview(ctx, e.user, s, 5); err != nil || len(got) != 1 {
		t.Errorf("ends after 3: %v, %v", got, err)
	}
	for name, change := range map[string]func(*schedules.Settings){
		"frequency":  func(s *schedules.Settings) { s.Frequency = "fortnight" },
		"every":      func(s *schedules.Settings) { s.Every = 0 },
		"time zone":  func(s *schedules.Settings) { s.TimeZone = "Mars/Olympus" },
		"both ends":  func(s *schedules.Settings) { s.EndDate = date("2027-01-01") },
		"no start":   func(s *schedules.Settings) { s.Start = time.Time{} },
		"after 24h":  func(s *schedules.Settings) { s.Minute = 24 * 60 },
		"end before": func(s *schedules.Settings) { s.EndCount, s.EndDate = 0, date("2026-08-01") },
	} {
		c := s
		change(&c)
		if _, err := e.svc.Preview(ctx, e.user, c, 5); !errors.Is(err, schedules.ErrInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := e.svc.Preview(ctx, e.user, s, 51); !errors.Is(err, schedules.ErrInvalid) {
		t.Errorf("count: %v", err)
	}
}

// queuedAt returns the schedule's queued occurrence at the time.
func (e env) queuedAt(t *testing.T, scheduleID, when string) schedules.Occurrence {
	t.Helper()
	page, err := e.svc.Occurrences(t.Context(), e.user, schedules.Filter{ScheduleID: scheduleID, State: sqlc.OccurrenceStateQueued})
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range page.Items {
		if o.ScheduledAt.Equal(at(when)) {
			return o
		}
	}
	t.Fatalf("no queued occurrence at %s in %+v", when, page.Items)
	return schedules.Occurrence{}
}

func TestApproveAndSkip(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	groceries := e.bucket(t, sqlc.RefillModeManual)
	s := e.daily("2026-10-10")
	s.Mode, s.DueDays = sqlc.ScheduleModeApprove, 1
	s.Transaction.Buckets = []transactions.BucketAmount{{BucketID: groceries, Amount: dec("60")}}
	sch := e.create(t, s)
	e.run(t, "2026-10-12T12:00:00Z")

	// As it is: dated at its time, in the cycle.
	first := e.queuedAt(t, sch.ID, "2026-10-10T12:00:00Z")
	o, tx, err := e.svc.Approve(ctx, e.user, first.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if o.State != sqlc.OccurrenceStateApplied || o.TransactionID != tx.ID || !o.ResolvedAt.Equal(at("2026-10-12T12:00:00Z")) ||
		!tx.At.Equal(at("2026-10-10T12:00:00Z")) || tx.ScheduleID != sch.ID || len(tx.BucketLines) != 1 {
		t.Errorf("approved %+v, %+v", o, tx)
	}
	if _, _, err := e.svc.Approve(ctx, e.user, first.ID, nil); !errors.Is(err, schedules.ErrResolved) {
		t.Errorf("approve twice: %v", err)
	}

	// Skipped: never recorded.
	second := e.queuedAt(t, sch.ID, "2026-10-11T12:00:00Z")
	if o, err := e.svc.Skip(ctx, e.user, second.ID); err != nil || o.State != sqlc.OccurrenceStateSkipped || o.TransactionID != "" {
		t.Errorf("skipped %+v, %v", o, err)
	}
	if _, err := e.svc.Skip(ctx, e.user, second.ID); !errors.Is(err, schedules.ErrResolved) {
		t.Errorf("skip twice: %v", err)
	}
	if _, _, err := e.svc.Approve(ctx, e.user, second.ID, nil); !errors.Is(err, schedules.ErrResolved) {
		t.Errorf("approve skipped: %v", err)
	}

	// Edited: another amount, no buckets, now.
	third := e.queuedAt(t, sch.ID, "2026-10-12T12:00:00Z")
	future := transactions.New{Type: sqlc.TransactionTypeEXP, AccountID: e.account, Amount: dec("70"), At: at("2026-10-13T00:00:00Z")}
	if _, _, err := e.svc.Approve(ctx, e.user, third.ID, &future); !errors.Is(err, schedules.ErrInvalid) {
		t.Errorf("in the future: %v", err)
	}
	edit := transactions.New{Type: sqlc.TransactionTypeEXP, AccountID: e.account, Amount: dec("70"), Counterparty: "Shop"}
	if _, tx, err := e.svc.Approve(ctx, e.user, third.ID, &edit); err != nil || !tx.At.Equal(at("2026-10-12T12:00:00Z")) ||
		tx.Counterparty != "Shop" || len(tx.BucketLines) != 0 || tx.ScheduleID != sch.ID {
		t.Errorf("edited %+v, %v", tx, err)
	}

	// Overdue a day after it was queued.
	e.run(t, "2026-10-13T12:00:00Z")
	if o, err := e.svc.GetOccurrence(ctx, e.user, e.queuedAt(t, sch.ID, "2026-10-13T12:00:00Z").ID); err != nil || o.Overdue {
		t.Errorf("not yet overdue %+v, %v", o, err)
	}
	*e.now = at("2026-10-14T12:00:01Z")
	fourth := e.queuedAt(t, sch.ID, "2026-10-13T12:00:00Z")
	if !fourth.Overdue {
		t.Errorf("overdue %+v", fourth)
	}

	// No active cycle: bucket lines can't be recorded, so it stays queued.
	if _, err := e.pool.Exec(ctx, `UPDATE cycles SET state = 'finished' WHERE id = $1`, e.cycle.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.svc.Approve(ctx, e.user, fourth.ID, nil); !errors.Is(err, ledger.ErrNoActiveCycle) {
		t.Errorf("no cycle: %v", err)
	}
	e.queuedAt(t, sch.ID, "2026-10-13T12:00:00Z")

	if _, err := e.svc.GetOccurrence(ctx, e.user, "999999000000000001"); !errors.Is(err, schedules.ErrNotFound) {
		t.Errorf("not found: %v", err)
	}
}

func TestApproveOutsideCycle(t *testing.T) {
	e := setup(t)
	s := e.daily("2026-10-31")
	s.Mode = sqlc.ScheduleModeApprove
	sch := e.create(t, s)
	// The cycle ended at 1 November; queued after it, the time isn't in the
	// cycle, so it's dated now.
	e.run(t, "2026-11-01T13:00:00Z")
	o := e.queuedAt(t, sch.ID, "2026-11-01T12:00:00Z")
	_, tx, err := e.svc.Approve(t.Context(), e.user, o.ID, nil)
	if err != nil || !tx.At.Equal(at("2026-11-01T13:00:00Z")) {
		t.Errorf("approved %+v, %v", tx, err)
	}
	// The one inside it keeps its time.
	_, tx, err = e.svc.Approve(t.Context(), e.user, e.queuedAt(t, sch.ID, "2026-10-31T12:00:00Z").ID, nil)
	if err != nil || !tx.At.Equal(at("2026-10-31T12:00:00Z")) {
		t.Errorf("approved %+v, %v", tx, err)
	}
}

func TestUpcomingAll(t *testing.T) {
	e := setup(t)
	daily := e.create(t, e.daily("2026-10-11"))
	weekly := e.daily("2026-10-10")
	weekly.Frequency, weekly.Minute = sqlc.ScheduleFrequencyWeek, 18*60
	w := e.create(t, weekly)
	paused := e.daily("2026-10-10")
	paused.Paused = true
	e.create(t, paused)

	got, err := e.svc.UpcomingAll(t.Context(), e.user, 4)
	if err != nil {
		t.Fatal(err)
	}
	var s []string
	for _, u := range got {
		name := "daily"
		if u.ScheduleID == w.ID {
			name = "weekly"
		}
		s = append(s, u.At.UTC().Format("01-02 15:04")+" "+name)
	}
	if !equal(s, []string{"10-10 18:00 weekly", "10-11 12:00 daily", "10-12 12:00 daily", "10-13 12:00 daily"}) {
		t.Errorf("upcoming %v (daily %s)", s, daily.ID)
	}
	if _, err := e.svc.UpcomingAll(t.Context(), e.user, 51); !errors.Is(err, schedules.ErrInvalid) {
		t.Errorf("count: %v", err)
	}
}

// Asking first, an occurrence is queued DueDays before its time, due then,
// and approved early it's dated now.
func TestApproveEarly(t *testing.T) {
	e := setup(t)
	s := e.daily("2026-10-20")
	s.Mode, s.DueDays, s.Frequency = sqlc.ScheduleModeApprove, 14, sqlc.ScheduleFrequencyMonth
	sch := e.create(t, s)
	e.run(t, "2026-10-05T12:00:00Z")
	if got := e.occurrences(t, sch.ID); len(got) != 0 {
		t.Errorf("15 days before: %v", got)
	}
	e.run(t, "2026-10-06T12:00:00Z")
	page, err := e.svc.Occurrences(t.Context(), e.user, schedules.Filter{ScheduleID: sch.ID})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("14 days before: %+v %v", page.Items, err)
	}
	o := page.Items[0]
	if !o.ScheduledAt.Equal(at("2026-10-20T12:00:00Z")) || !o.DueAt.Equal(o.ScheduledAt) || o.Overdue {
		t.Errorf("queued %+v", o)
	}
	_, tx, err := e.svc.Approve(t.Context(), e.user, o.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !tx.At.Equal(at("2026-10-06T12:00:00Z")) {
		t.Errorf("approved early, dated %v", tx.At)
	}
	if got, err := e.svc.Get(t.Context(), e.user, sch.ID); err != nil || !got.NextAt.Equal(at("2026-11-20T12:00:00Z")) {
		t.Errorf("next %+v %v", got, err)
	}
}
