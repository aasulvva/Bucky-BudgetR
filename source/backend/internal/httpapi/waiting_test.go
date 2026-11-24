package httpapi_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/allocation"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cycles"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/notifications"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/refill"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/schedules"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// waitingWorld is a user with the services counting a purchase in its bucket
// later needs (#264), on a clock the test sets.
type waitingWorld struct {
	t   *testing.T
	now *time.Time
	h   http.Handler
	c   *http.Cookie
}

func newWaitingWorld(t *testing.T, start time.Time) *waitingWorld {
	t.Helper()
	pool := testdb.New(t)
	now := start
	clock := func() time.Time { return now }
	l := ledger.New(ledger.Options{AfterRecord: allocation.AfterRecord})
	r := refill.NewService(pool, l, refill.Options{Now: clock})
	tx := transactions.NewService(pool, l, transactions.Options{Now: clock, Refills: r})
	sch := schedules.NewService(pool, schedules.Options{Now: clock, Transactions: tx})
	bk := buckets.NewService(pool, l, buckets.Options{Now: clock})
	h := newHandler(t, discard(), pool, httpapi.Options{
		Auth:          auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge}),
		Accounts:      accounts.NewService(pool, l, accounts.Options{Now: clock, Transactions: tx, Schedules: sch}),
		Cycles:        cycles.NewService(pool, cycles.Options{Now: clock, OnEnd: r.OnEnd, OnStart: r.OnStart}),
		Buckets:       bk,
		Transactions:  tx,
		Schedules:     sch,
		Refills:       r,
		Notifications: notifications.NewService(pool, notifications.Options{Now: clock, Schedules: sch, Buckets: bk}),
	})
	authtest.NewUser(t, pool, "alice")
	return &waitingWorld{t: t, now: &now, h: h, c: authtest.Login(t, h, "alice")}
}

func (w *waitingWorld) do(method, path string, body any) *httptest.ResponseRecorder {
	w.t.Helper()
	return authtest.Do(w.t, w.h, method, path, body, w.c)
}

func (w *waitingWorld) ok(what, method, path string, body any, status int) *httptest.ResponseRecorder {
	w.t.Helper()
	r := w.do(method, path, body)
	expect(w.t, what, r, status, "")
	return r
}

func (w *waitingWorld) account(id string) api.Account {
	w.t.Helper()
	return decode[api.Account](w.t, w.ok("account", http.MethodGet, "/api/v1/accounts/"+id, nil, http.StatusOK))
}

func (w *waitingWorld) bucket(id string) api.Bucket {
	w.t.Helper()
	return decode[api.Bucket](w.t, w.ok("bucket", http.MethodGet, "/api/v1/buckets/"+id, nil, http.StatusOK))
}

func (w *waitingWorld) cycle(start, end time.Time) api.Cycle {
	w.t.Helper()
	return decode[api.Cycle](w.t, w.ok("plan cycle", http.MethodPost, "/api/v1/cycles",
		map[string]any{"start_at": start.Format(time.RFC3339), "end_at": end.Format(time.RFC3339)}, http.StatusCreated))
}

// used is a bucket's Used in a cycle.
func (w *waitingWorld) used(cycleID, bucketID string) string {
	w.t.Helper()
	for _, f := range decode[[]api.BucketFigures](w.t, w.ok("figures", http.MethodGet,
		"/api/v1/cycles/"+cycleID+"/bucket-figures", nil, http.StatusOK)) {
		if f.BucketId == bucketID {
			return f.Used
		}
	}
	w.t.Fatalf("no figures for %s", bucketID)
	return ""
}

func (w *waitingWorld) purchase(what string, body map[string]any, status int, code string) api.Transaction {
	w.t.Helper()
	body["type"] = "EXP"
	r := w.do(http.MethodPost, "/api/v1/transactions", body)
	expect(w.t, what, r, status, code)
	if status != http.StatusCreated {
		return api.Transaction{}
	}
	return decode[api.Transaction](w.t, r)
}

func (w *waitingWorld) transaction(id string) api.Transaction {
	w.t.Helper()
	return decode[api.Transaction](w.t, w.ok("get", http.MethodGet, "/api/v1/transactions/"+id, nil, http.StatusOK))
}

// left is what's left of a purchase's only waiting charge.
func left(t *testing.T, tr api.Transaction) string {
	t.Helper()
	if len(tr.Waiting) != 1 {
		t.Fatalf("waiting charges %+v", tr.Waiting)
	}
	return tr.Waiting[0].Left
}

// TestWaitingCardLoan: a card used as a loan (#264). A trip on the card
// counts in the Vacation bucket as it's paid off: payments clear the card's
// debt oldest first, and the bucket takes what reaches the trip, in the cycle
// it's paid, while Main's unallocated money never moves.
func TestWaitingCardLoan(t *testing.T) {
	w := newWaitingWorld(t, time.Date(2027, 1, 5, 10, 0, 0, 0, time.UTC))
	jan := w.cycle(time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(2027, 2, 1, 0, 0, 0, 0, time.UTC))
	feb := w.cycle(time.Date(2027, 2, 1, 0, 0, 0, 0, time.UTC), time.Date(2027, 3, 1, 0, 0, 0, 0, time.UTC))
	mar := w.cycle(time.Date(2027, 3, 1, 0, 0, 0, 0, time.UTC), time.Date(2027, 4, 1, 0, 0, 0, 0, time.UTC))
	w.ok("start January", http.MethodPost, "/api/v1/cycles/"+jan.Id+"/start", nil, http.StatusOK)
	main := decode[api.Account](t, w.ok("Main", http.MethodPost, "/api/v1/accounts",
		map[string]any{"name": "Main", "opening_balance": "50000", "opening_at": "2027-01-02T12:00:00Z"}, http.StatusCreated))
	visa := decode[api.Account](t, w.ok("Visa", http.MethodPost, "/api/v1/accounts", map[string]any{
		"name": "Visa", "type": "credit_card", "bank": "DNB", "opening_balance": "-2000", "opening_at": "2027-01-02T12:00:00Z",
		"credit_card": map[string]any{"credit_limit": "50000", "statement_day": 1, "due_day": 15,
			"minimum_payment": "300", "default_account_id": main.Id},
	}, http.StatusCreated))
	vacation := decode[api.Bucket](t, w.ok("Vacation", http.MethodPost, "/api/v1/buckets", map[string]any{
		"name": "Vacation", "source_account_id": main.Id, "refill_amount": "30000", "refill_mode": "manual", "keep_funds": true,
		"cap_mode": "fixed", "cap_amount": "60000",
	}, http.StatusCreated))
	w.ok("refill Vacation", http.MethodPost, "/api/v1/buckets/"+vacation.Id+"/refill", nil, http.StatusOK)
	before := w.account(main.Id).Unallocated
	steady := func(what string) {
		t.Helper()
		if got := w.account(main.Id).Unallocated; got != before {
			t.Fatalf("%s: Main's unallocated %s, was %s", what, got, before)
		}
	}

	w.purchase("paid on a debit account", map[string]any{"account_id": main.Id, "amount": "100",
		"bucket_lines": []map[string]any{{"bucket_id": vacation.Id, "amount": "100"}},
		"count_later":  map[string]any{"when": "paid"}}, http.StatusBadRequest, "card_only")
	trip := w.purchase("the trip", map[string]any{"account_id": visa.Id, "amount": "30000", "counterparty": "Travel Co",
		"bucket_lines": []map[string]any{{"bucket_id": vacation.Id, "amount": "30000"}},
		"count_later":  map[string]any{"when": "paid"}}, http.StatusCreated, "")
	if len(trip.BucketLines) != 0 || len(trip.WaitingLines) != 1 || trip.WaitingLines[0].Amount != "30000.00" ||
		left(t, trip) != "30000.00" || trip.Waiting[0].When != api.WaitingChargeWhenPaid {
		t.Fatalf("the trip %+v", trip)
	}
	steady("bought")
	if m := w.account(main.Id); m.Waiting != "30000.00" {
		t.Fatalf("Main waiting %s", m.Waiting)
	}
	if b := w.bucket(vacation.Id); b.TargetFunds != "30000.00" {
		t.Fatalf("Vacation %s", b.TargetFunds)
	}
	if open := decode[[]api.OpenWaitingCharge](t, w.ok("open", http.MethodGet,
		"/api/v1/waiting-charges?account_id="+main.Id, nil, http.StatusOK)); len(open) != 1 || open[0].Left != "30000.00" ||
		open[0].PurchaseId != trip.Id || open[0].Counterparty != "Travel Co" {
		t.Fatalf("open charges %+v", open)
	}

	// February: 7 000 is paid. The 2 000 from before goes first, so 5 000
	// reaches the trip.
	*w.now = time.Date(2027, 2, 5, 10, 0, 0, 0, time.UTC)
	w.ok("end January", http.MethodPost, "/api/v1/cycles/"+jan.Id+"/end", map[string]any{}, http.StatusOK)
	pay := func(what, amount string) api.Transaction {
		t.Helper()
		return decode[api.Transaction](t, w.ok(what, http.MethodPost, "/api/v1/transactions", map[string]any{
			"type": "TRF", "account_id": main.Id, "to_account_id": visa.Id, "amount": amount,
		}, http.StatusCreated))
	}
	first := pay("pay 7 000", "7000")
	if got := left(t, w.transaction(trip.Id)); got != "25000.00" {
		t.Fatalf("after 7 000: left %s", got)
	}
	if b := w.bucket(vacation.Id); b.TargetFunds != "25000.00" {
		t.Fatalf("Vacation after 7 000: %s", b.TargetFunds)
	}
	if got := w.used(feb.Id, vacation.Id); got != "5000.00" {
		t.Fatalf("February's used %s", got)
	}
	steady("paid 7 000")

	// Reversing the payment gives it back; paying again takes it again.
	w.ok("reverse the payment", http.MethodPost, "/api/v1/transactions/"+first.Id+"/reversal", nil, http.StatusOK)
	if got := left(t, w.transaction(trip.Id)); got != "30000.00" {
		t.Fatalf("after the reversal: left %s", got)
	}
	if got := w.used(feb.Id, vacation.Id); got != "0.00" {
		t.Fatalf("February's used after the reversal %s", got)
	}
	steady("payment reversed")
	pay("pay 7 000 again", "7000")
	steady("paid 7 000 again")

	// March: the rest is paid off.
	*w.now = time.Date(2027, 3, 5, 10, 0, 0, 0, time.UTC)
	w.ok("end February", http.MethodPost, "/api/v1/cycles/"+feb.Id+"/end", map[string]any{}, http.StatusOK)
	pay("pay 25 000", "25000")
	if got := left(t, w.transaction(trip.Id)); got != "0.00" {
		t.Fatalf("paid off: left %s", got)
	}
	if got := w.used(mar.Id, vacation.Id); got != "25000.00" {
		t.Fatalf("March's used %s", got)
	}
	if got := w.used(feb.Id, vacation.Id); got != "5000.00" {
		t.Fatalf("February's used, later %s", got)
	}
	if m := w.account(main.Id); m.Waiting != "0.00" {
		t.Fatalf("Main waiting at the end %s", m.Waiting)
	}
	// Only the 2 000 from before, which nothing set aside, costs Main
	// unallocated money (#261).
	before = "18000.00"
	steady("paid off")
	// The payments took it, so there's no notification.
	for _, n := range decode[api.NotificationList](t, w.ok("notifications", http.MethodGet, "/api/v1/notifications", nil, http.StatusOK)).Items {
		if n.Kind == api.NotificationKindBucketCharge {
			t.Fatalf("a notification %+v", n)
		}
	}
	// Taking the trip back is too late: February is finished.
	expect(t, "reverse the trip", w.do(http.MethodPost, "/api/v1/transactions/"+trip.Id+"/reversal", nil),
		http.StatusConflict, "charge_taken")
}

// TestWaitingLaterCycle: a purchase that counts in a later cycle or month
// (#264), taken at that cycle's start; Take now, corrections, reversing,
// deleting the bucket and the notification.
func TestWaitingLaterCycle(t *testing.T) {
	w := newWaitingWorld(t, time.Date(2027, 1, 5, 10, 0, 0, 0, time.UTC))
	jan := w.cycle(time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(2027, 2, 1, 0, 0, 0, 0, time.UTC))
	feb := w.cycle(time.Date(2027, 2, 1, 0, 0, 0, 0, time.UTC), time.Date(2027, 3, 1, 0, 0, 0, 0, time.UTC))
	main := decode[api.Account](t, w.ok("Main", http.MethodPost, "/api/v1/accounts",
		map[string]any{"name": "Main", "opening_balance": "10000", "opening_at": "2027-01-02T12:00:00Z"}, http.StatusCreated))
	newBucket := func(name, mode string) api.Bucket {
		t.Helper()
		return decode[api.Bucket](t, w.ok(name, http.MethodPost, "/api/v1/buckets", map[string]any{
			"name": name, "source_account_id": main.Id, "refill_amount": "1000", "refill_mode": mode,
		}, http.StatusCreated))
	}
	games, old := newBucket("Games", "auto"), newBucket("Old", "manual")
	buy := func(what, amount, bucketID string, later map[string]any) api.Transaction {
		t.Helper()
		return w.purchase(what, map[string]any{"account_id": main.Id, "amount": amount, "counterparty": what,
			"bucket_lines": []map[string]any{{"bucket_id": bucketID, "amount": amount}}, "count_later": later},
			http.StatusCreated, "")
	}

	// Without an active cycle: it waits all the same, but can't be taken.
	game := buy("Game", "1000", games.Id, map[string]any{"when": "cycle", "cycle_id": feb.Id})
	expect(t, "take without a cycle", w.do(http.MethodPost, "/api/v1/waiting-charges/"+game.Waiting[0].Id+"/take", nil),
		http.StatusConflict, "no_active_cycle")
	w.ok("start January", http.MethodPost, "/api/v1/cycles/"+jan.Id+"/start", nil, http.StatusOK)
	// Games got its refill; the game's 1 000 is an advance on Main.
	if m := w.account(main.Id); m.Unallocated != "9000.00" || m.Waiting != "1000.00" {
		t.Fatalf("January Main %+v", m)
	}

	// Validation.
	w.purchase("the active cycle", map[string]any{"account_id": main.Id, "amount": "1",
		"bucket_lines": []map[string]any{{"bucket_id": games.Id, "amount": "1"}},
		"count_later":  map[string]any{"when": "cycle", "cycle_id": jan.Id}}, http.StatusBadRequest, "invalid_request")
	w.purchase("this month", map[string]any{"account_id": main.Id, "amount": "1",
		"bucket_lines": []map[string]any{{"bucket_id": games.Id, "amount": "1"}},
		"count_later":  map[string]any{"when": "month", "month": "2027-01"}}, http.StatusBadRequest, "invalid_request")
	w.purchase("no buckets", map[string]any{"account_id": main.Id, "amount": "1",
		"count_later": map[string]any{"when": "month", "month": "2027-03"}}, http.StatusBadRequest, "invalid_request")
	expect(t, "an income", w.do(http.MethodPost, "/api/v1/transactions", map[string]any{
		"type": "INC", "account_id": main.Id, "amount": "1",
		"bucket_lines": []map[string]any{{"bucket_id": games.Id, "amount": "1"}},
		"count_later":  map[string]any{"when": "month", "month": "2027-03"},
	}), http.StatusBadRequest, "invalid_request")

	// March has no cycle yet.
	console := buy("Console", "500", games.Id, map[string]any{"when": "month", "month": "2027-03"})
	// Take now: the bucket counts it in January.
	pad := buy("Pad", "200", games.Id, map[string]any{"when": "cycle", "cycle_id": feb.Id})
	taken := decode[api.Transaction](t, w.ok("take now", http.MethodPost,
		"/api/v1/waiting-charges/"+pad.Waiting[0].Id+"/take", nil, http.StatusOK))
	if left(t, taken) != "0.00" || w.used(jan.Id, games.Id) != "200.00" {
		t.Fatalf("taken now %+v", taken)
	}
	expect(t, "take twice", w.do(http.MethodPost, "/api/v1/waiting-charges/"+pad.Waiting[0].Id+"/take", nil),
		http.StatusConflict, "charge_closed")
	if m := w.account(main.Id); m.Unallocated != "9000.00" {
		t.Fatalf("after taking: Main %+v", m)
	}

	// Corrections: the game costs more; the pad's part can't go below what
	// was taken; reversing the pad gives the bucket its 200 back.
	w.ok("the game costs more", http.MethodPost, "/api/v1/transactions/"+game.Id+"/correction", map[string]any{
		"amount": "1200", "bucket_lines": []map[string]any{{"bucket_id": games.Id, "amount": "1200"}},
	}, http.StatusOK)
	if got := left(t, w.transaction(game.Id)); got != "1200.00" {
		t.Fatalf("corrected game: left %s", got)
	}
	expect(t, "less than taken", w.do(http.MethodPost, "/api/v1/transactions/"+pad.Id+"/correction", map[string]any{
		"amount": "100", "bucket_lines": []map[string]any{{"bucket_id": games.Id, "amount": "100"}},
	}), http.StatusConflict, "charge_taken")
	expect(t, "a new counterparty", w.do(http.MethodPost, "/api/v1/transactions/"+game.Id+"/correction", map[string]any{"counterparty": "x"}),
		http.StatusOK, "")
	w.ok("reverse the pad", http.MethodPost, "/api/v1/transactions/"+pad.Id+"/reversal", nil, http.StatusOK)
	if got := w.used(jan.Id, games.Id); got != "0.00" {
		t.Fatalf("January's used after the reversal %s", got)
	}
	if m := w.account(main.Id); m.Unallocated != "9000.00" || m.Waiting != "1700.00" {
		t.Fatalf("after the corrections: Main %+v", m)
	}

	// A bucket that's deleted no longer owes its account anything.
	gone := buy("Gone", "300", old.Id, map[string]any{"when": "month", "month": "2027-06"})
	w.ok("delete Old", http.MethodDelete, "/api/v1/buckets/"+old.Id, nil, http.StatusNoContent)
	if m := w.account(main.Id); m.Waiting != "1700.00" || m.Unallocated != "8700.00" {
		t.Fatalf("after deleting Old: Main %+v", m)
	}
	if tr := w.transaction(gone.Id); !tr.Waiting[0].BucketDeleted {
		t.Fatalf("gone %+v", tr.Waiting)
	}
	expect(t, "take for a deleted bucket", w.do(http.MethodPost, "/api/v1/waiting-charges/"+gone.Waiting[0].Id+"/take", nil),
		http.StatusConflict, "charge_closed")

	// February's start takes the game, after the refill, and tells of it.
	*w.now = time.Date(2027, 2, 2, 10, 0, 0, 0, time.UTC)
	w.ok("end January", http.MethodPost, "/api/v1/cycles/"+jan.Id+"/end", map[string]any{}, http.StatusOK)
	if got := left(t, w.transaction(game.Id)); got != "0.00" {
		t.Fatalf("February: game left %s", got)
	}
	if got := w.used(feb.Id, games.Id); got != "1200.00" {
		t.Fatalf("February's used %s", got)
	}
	charges := func() []api.Notification {
		t.Helper()
		var out []api.Notification
		for _, n := range decode[api.NotificationList](t, w.ok("notifications", http.MethodGet, "/api/v1/notifications", nil, http.StatusOK)).Items {
			if n.Kind == api.NotificationKindBucketCharge {
				out = append(out, n)
			}
		}
		return out
	}
	got := charges()
	if len(got) != 1 || got[0].Amount.MustGet() != "1200.00" || got[0].BucketId.MustGet() != games.Id ||
		got[0].TransactionId.MustGet() != game.Id || got[0].Counterparty.MustGet() != "x" ||
		got[0].At.MustGet().Format(time.RFC3339) != "2027-02-01T00:00:00Z" {
		t.Fatalf("February's notifications %+v", got)
	}
	w.ok("switched off", http.MethodPatch, "/api/v1/me/preferences",
		map[string]any{"notifications": map[string]any{"bucket_charges": false}}, http.StatusOK)
	if got := charges(); len(got) != 0 {
		t.Fatalf("switched off %+v", got)
	}
	w.ok("switched on", http.MethodPatch, "/api/v1/me/preferences",
		map[string]any{"notifications": map[string]any{"bucket_charges": true}}, http.StatusOK)
	w.ok("dismiss", http.MethodPost, "/api/v1/notifications/dismiss", map[string]any{"key": got[0].Key}, http.StatusNoContent)
	if got := charges(); len(got) != 0 {
		t.Fatalf("dismissed %+v", got)
	}

	// March is planned later, and its start takes the console.
	mar := w.cycle(time.Date(2027, 3, 1, 0, 0, 0, 0, time.UTC), time.Date(2027, 4, 1, 0, 0, 0, 0, time.UTC))
	*w.now = time.Date(2027, 3, 2, 10, 0, 0, 0, time.UTC)
	w.ok("end February", http.MethodPost, "/api/v1/cycles/"+feb.Id+"/end", map[string]any{}, http.StatusOK)
	if got := left(t, w.transaction(console.Id)); got != "0.00" {
		t.Fatalf("March: console left %s", got)
	}
	if got := w.used(mar.Id, games.Id); got != "500.00" {
		t.Fatalf("March's used %s", got)
	}
	if m := w.account(main.Id); m.Waiting != "0.00" {
		t.Fatalf("March: Main %+v", m)
	}

	// Stats by bucket count the spending when the bucket took it, and the
	// purchases not on no bucket when they happened.
	series := decode[api.StatsSeries](t, w.ok("stats", http.MethodGet, "/api/v1/stats/series?metric=spending&resolution=month"+
		"&from=2027-01-01T00:00:00Z&to=2027-04-01T00:00:00Z&time_zone=UTC&group_by=bucket", nil, http.StatusOK))
	seen := false
	for _, s := range series.Series {
		id, _ := s.BucketId.Get()
		seen = seen || id == games.Id
		switch {
		case id == games.Id && (len(s.Values) != 3 || s.Values[0] != "0.00" || s.Values[1] != "1200.00" || s.Values[2] != "500.00"):
			t.Errorf("Games' spending %v", s.Values)
		case id == "" && len(s.Values) > 0 && s.Values[0] != "0.00":
			t.Errorf("spending on no bucket %v", s.Values)
		}
	}
	if !seen {
		t.Errorf("no series for Games: %+v", series.Series)
	}
}

// TestWaitingPaidCatchUp: a card purchase paid off while no cycle is active
// waits for the next cycle's start, which takes it and tells of it (#264).
func TestWaitingPaidCatchUp(t *testing.T) {
	w := newWaitingWorld(t, time.Date(2027, 1, 5, 10, 0, 0, 0, time.UTC))
	jan := w.cycle(time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(2027, 2, 1, 0, 0, 0, 0, time.UTC))
	feb := w.cycle(time.Date(2027, 2, 1, 0, 0, 0, 0, time.UTC), time.Date(2027, 3, 1, 0, 0, 0, 0, time.UTC))
	w.ok("start January", http.MethodPost, "/api/v1/cycles/"+jan.Id+"/start", nil, http.StatusOK)
	main := decode[api.Account](t, w.ok("Main", http.MethodPost, "/api/v1/accounts",
		map[string]any{"name": "Main", "opening_balance": "10000", "opening_at": "2027-01-02T12:00:00Z"}, http.StatusCreated))
	visa := decode[api.Account](t, w.ok("Visa", http.MethodPost, "/api/v1/accounts", map[string]any{
		"name": "Visa", "type": "credit_card", "credit_card": map[string]any{"credit_limit": "5000", "statement_day": 1,
			"due_day": 15, "minimum_payment": "300", "default_account_id": main.Id},
	}, http.StatusCreated))
	fun := decode[api.Bucket](t, w.ok("Fun", http.MethodPost, "/api/v1/buckets", map[string]any{
		"name": "Fun", "source_account_id": main.Id, "refill_amount": "1000", "refill_mode": "manual", "keep_funds": true,
		"cap_mode": "fixed", "cap_amount": "5000",
	}, http.StatusCreated))
	w.ok("refill Fun", http.MethodPost, "/api/v1/buckets/"+fun.Id+"/refill", nil, http.StatusOK)
	shoes := w.purchase("shoes", map[string]any{"account_id": visa.Id, "amount": "600", "counterparty": "Shoe shop",
		"bucket_lines": []map[string]any{{"bucket_id": fun.Id, "amount": "600"}},
		"count_later":  map[string]any{"when": "paid"}}, http.StatusCreated, "")

	*w.now = time.Date(2027, 1, 20, 10, 0, 0, 0, time.UTC)
	w.ok("end January early", http.MethodPost, "/api/v1/cycles/"+jan.Id+"/end", map[string]any{}, http.StatusOK)
	w.ok("pay the card", http.MethodPost, "/api/v1/transactions", map[string]any{
		"type": "TRF", "account_id": main.Id, "to_account_id": visa.Id, "amount": "600",
	}, http.StatusCreated)
	if got := left(t, w.transaction(shoes.Id)); got != "600.00" {
		t.Fatalf("without a cycle: left %s", got)
	}
	w.ok("start February", http.MethodPost, "/api/v1/cycles/"+feb.Id+"/start", nil, http.StatusOK)
	if got := left(t, w.transaction(shoes.Id)); got != "0.00" {
		t.Fatalf("February: left %s", got)
	}
	if got := w.used(feb.Id, fun.Id); got != "600.00" {
		t.Fatalf("February's used %s", got)
	}
	var found bool
	for _, n := range decode[api.NotificationList](t, w.ok("notifications", http.MethodGet, "/api/v1/notifications", nil, http.StatusOK)).Items {
		if n.Kind == api.NotificationKindBucketCharge && n.Amount.MustGet() == "600.00" && n.Counterparty.MustGet() == "Shoe shop" {
			found = true
		}
	}
	if !found {
		t.Fatal("no notification of the catch-up")
	}
}
