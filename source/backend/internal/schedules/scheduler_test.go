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

func TestRunAuto(t *testing.T) {
	e := setup(t)
	onIncome := e.bucket(t, sqlc.RefillModeOnIncome)
	yes := true
	s := e.daily("2026-10-10")
	s.Transaction = transactions.New{
		Type: sqlc.TransactionTypeINC, AccountID: e.account, Amount: dec("1000"), Counterparty: "Salary", Tags: []string{"pay"},
		Buckets: []transactions.BucketAmount{{BucketID: onIncome, Amount: dec("50")}}, TriggersRefill: &yes,
	}
	s.EndCount = 3
	// Today's 12:00 is now, so it's the first.
	sch := e.create(t, s)
	if sch.NextIndex != 0 {
		t.Fatalf("next %d", sch.NextIndex)
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
	if !tr.At.Equal(at("2026-10-10T12:00:00Z")) || tr.Counterparty != "Salary" || len(tr.Tags) != 1 || !tr.TriggersRefill ||
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
	page, err := e.svc.Occurrences(t.Context(), e.user, schedules.Filter{ScheduleID: a.ID})
	if err != nil {
		t.Fatal(err)
	}
	if o := page.Items[0]; o.State != sqlc.OccurrenceStateQueued || o.Reason != sqlc.OccurrenceReasonApproval ||
		!o.DueAt.Equal(at("2026-10-16T12:00:00Z")) || o.TransactionID != "" {
		t.Errorf("approval %+v", o)
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
	if !equal(seen, []string{"10-14", "10-13", "10-12", "10-11", "10-10"}) {
		t.Errorf("pages %v", seen)
	}
	if _, err := e.svc.Occurrences(t.Context(), e.user, schedules.Filter{Cursor: "nope"}); !errors.Is(err, schedules.ErrInvalid) {
		t.Errorf("bad cursor %v", err)
	}
	if page, err := e.svc.Occurrences(t.Context(), authtest.NewUser(t, e.pool, "bob").ID, schedules.Filter{ScheduleID: sch.ID}); err != nil || len(page.Items) != 0 {
		t.Errorf("bob sees %v %v", page, err)
	}
}
