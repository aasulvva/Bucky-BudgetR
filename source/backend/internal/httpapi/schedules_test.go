package httpapi_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/schedules"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

func TestSchedulesAPI(t *testing.T) {
	pool := testdb.New(t)
	l := ledger.New(ledger.Options{})
	now := time.Date(2026, 11, 8, 10, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	tx := transactions.NewService(pool, l, transactions.Options{Now: clock})
	svc := schedules.NewService(pool, schedules.Options{Now: clock, Transactions: tx})
	h := newHandler(t, discard(), pool, httpapi.Options{
		Auth:         auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge}),
		Accounts:     accounts.NewService(pool, l, accounts.Options{Now: clock}),
		Buckets:      buckets.NewService(pool, l, buckets.Options{Now: clock}),
		Transactions: tx,
		Schedules:    svc,
	})
	authtest.NewUser(t, pool, "alice")
	authtest.NewUser(t, pool, "bob")
	alice, bob := authtest.Login(t, h, "alice"), authtest.Login(t, h, "bob")
	do := func(method, path string, body any, c *http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		return authtest.Do(t, h, method, path, body, c)
	}

	w := do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": "Main", "opening_balance": "10000"}, alice)
	expect(t, "create account", w, http.StatusCreated, "")
	main := decode[api.Account](t, w).Id
	w = do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": "Savings"}, alice)
	expect(t, "create savings", w, http.StatusCreated, "")
	savings := decode[api.Account](t, w).Id
	w = do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": "Bob's"}, bob)
	expect(t, "create bob's account", w, http.StatusCreated, "")
	bobs := decode[api.Account](t, w).Id
	w = do(http.MethodPost, "/api/v1/buckets", map[string]any{"name": "Rent", "source_account_id": main}, alice)
	expect(t, "create bucket", w, http.StatusCreated, "")
	rent := decode[api.Bucket](t, w).Id

	// A monthly transfer on the 25th at 08:00 Oslo time, from August: the
	// next is 25 November.
	transfer := map[string]any{
		"name":        "Savings",
		"transaction": map[string]any{"type": "TRF", "account_id": main, "to_account_id": savings, "amount": "1500"},
		"mode":        "auto", "start_date": "2026-08-25", "time": "08:00", "time_zone": "Europe/Oslo", "frequency": "month",
	}
	expect(t, "no session", do(http.MethodPost, "/api/v1/schedules", transfer, nil), http.StatusUnauthorized, "unauthenticated")
	w = do(http.MethodPost, "/api/v1/schedules", transfer, alice)
	expect(t, "create", w, http.StatusCreated, "")
	sch := decode[api.Schedule](t, w)
	if sch.Name != "Savings" || sch.Every != 1 || sch.DueDays != 3 || sch.Time != "08:00" || sch.NextIndex != 3 ||
		!sch.NextAt.MustGet().Equal(time.Date(2026, 11, 25, 7, 0, 0, 0, time.UTC)) || sch.EndCount.IsSpecified() && !sch.EndCount.IsNull() ||
		sch.Transaction.Amount != "1500.00" || *sch.Transaction.ToAccountId != savings {
		t.Errorf("created %+v", sch)
	}

	w = do(http.MethodGet, "/api/v1/schedules/"+sch.Id+"/upcoming?count=3", nil, alice)
	expect(t, "upcoming", w, http.StatusOK, "")
	if up := decode[[]time.Time](t, w); len(up) != 3 || !up[2].Equal(time.Date(2027, 1, 25, 7, 0, 0, 0, time.UTC)) {
		t.Errorf("upcoming %v", up)
	}
	expect(t, "upcoming count", do(http.MethodGet, "/api/v1/schedules/"+sch.Id+"/upcoming?count=51", nil, alice), http.StatusBadRequest, "invalid_request")

	// An expense to approve, ending after 2.
	expense := map[string]any{
		"transaction": map[string]any{"type": "EXP", "account_id": main, "amount": "9000", "counterparty": "Landlord",
			"tags": []string{"home"}, "bucket_lines": []map[string]any{{"bucket_id": rent, "amount": "9000"}}},
		"mode": "approve", "due_days": 7, "start_date": "2026-11-08", "time": "10:00", "frequency": "week", "every": 2, "end_count": 2,
	}
	w = do(http.MethodPost, "/api/v1/schedules", expense, alice)
	expect(t, "create expense", w, http.StatusCreated, "")
	exp := decode[api.Schedule](t, w)
	if exp.TimeZone != "UTC" || exp.EndCount.MustGet() != 2 || len(*exp.Transaction.BucketLines) != 1 ||
		!exp.NextAt.MustGet().Equal(now) {
		t.Errorf("expense %+v", exp)
	}

	for name, change := range map[string]func(map[string]any){
		"TRF without to":     func(b map[string]any) { delete(b["transaction"].(map[string]any), "to_account_id") },
		"bob's account":      func(b map[string]any) { b["transaction"].(map[string]any)["account_id"] = bobs },
		"over the amount":    func(b map[string]any) { b["transaction"].(map[string]any)["amount"] = "1" },
		"passed":             func(b map[string]any) { b["frequency"], b["start_date"] = "once", "2026-11-01" },
		"count and date":     func(b map[string]any) { b["end_date"] = "2027-01-01" },
		"bad time":           func(b map[string]any) { b["time"] = "24:00" },
		"bad time zone":      func(b map[string]any) { b["time_zone"] = "Mars/Olympus" },
		"due days":           func(b map[string]any) { b["due_days"] = 61 },
		"system type":        func(b map[string]any) { b["transaction"].(map[string]any)["type"] = "REF" },
		"unknown field":      func(b map[string]any) { b["colour"] = "red" },
		"frequency":          func(b map[string]any) { b["frequency"] = "fortnight" },
		"long name":          func(b map[string]any) { b["name"] = string(make([]rune, 61)) },
		"bucket on transfer": func(b map[string]any) { b["transaction"].(map[string]any)["type"] = "TRF" },
	} {
		body := map[string]any{
			"transaction": map[string]any{"type": "EXP", "account_id": main, "to_account_id": savings, "amount": "100",
				"bucket_lines": []map[string]any{{"bucket_id": rent, "amount": "50"}}},
			"mode": "auto", "start_date": "2026-11-09", "time": "08:00", "frequency": "day", "end_count": 3,
		}
		if name == "TRF without to" {
			body["transaction"].(map[string]any)["type"] = "TRF"
			delete(body["transaction"].(map[string]any), "bucket_lines")
		} else if name != "bucket on transfer" {
			delete(body["transaction"].(map[string]any), "to_account_id")
		}
		change(body)
		expect(t, name, do(http.MethodPost, "/api/v1/schedules", body, alice), http.StatusBadRequest, "invalid_request")
	}

	// Bob sees none of it.
	expect(t, "bob gets", do(http.MethodGet, "/api/v1/schedules/"+sch.Id, nil, bob), http.StatusNotFound, "not_found")
	expect(t, "bob deletes", do(http.MethodDelete, "/api/v1/schedules/"+sch.Id, nil, bob), http.StatusNotFound, "not_found")
	w = do(http.MethodGet, "/api/v1/schedules", nil, bob)
	expect(t, "bob lists", w, http.StatusOK, "")
	if got := decode[[]api.Schedule](t, w); len(got) != 0 {
		t.Errorf("bob sees %v", got)
	}

	w = do(http.MethodGet, "/api/v1/schedules", nil, alice)
	expect(t, "list", w, http.StatusOK, "")
	if got := decode[[]api.Schedule](t, w); len(got) != 2 || got[0].Id != exp.Id || got[1].Id != sch.Id {
		t.Errorf("list %+v", got)
	}

	// The scheduler queues the expense for approval.
	if err := svc.RunDue(t.Context(), discard()); err != nil {
		t.Fatal(err)
	}
	w = do(http.MethodGet, "/api/v1/scheduled-transactions?state=queued", nil, alice)
	expect(t, "queued", w, http.StatusOK, "")
	page := decode[api.ScheduledTransactionPage](t, w)
	if len(page.Items) != 1 || page.Items[0].ScheduleId != exp.Id || page.Items[0].Reason.MustGet() != api.ScheduledTransactionReasonApproval ||
		!page.Items[0].DueAt.MustGet().Equal(page.Items[0].ScheduledAt) || page.Items[0].TransactionId.IsSpecified() && !page.Items[0].TransactionId.IsNull() ||
		!page.NextCursor.IsNull() {
		t.Errorf("queued %+v", page)
	}
	w = do(http.MethodGet, "/api/v1/scheduled-transactions?state=applied&schedule_id="+exp.Id, nil, alice)
	expect(t, "applied", w, http.StatusOK, "")
	if page := decode[api.ScheduledTransactionPage](t, w); len(page.Items) != 0 {
		t.Errorf("applied %+v", page)
	}
	expect(t, "bad state", do(http.MethodGet, "/api/v1/scheduled-transactions?state=lost", nil, alice), http.StatusBadRequest, "invalid_request")

	// Approving it: its bucket line needs an active cycle, so it stays queued.
	qid := page.Items[0].Id
	base := "/api/v1/scheduled-transactions/" + qid
	expect(t, "bob gets queued", do(http.MethodGet, base, nil, bob), http.StatusNotFound, "not_found")
	expect(t, "bob approves", do(http.MethodPost, base+"/approve", nil, bob), http.StatusNotFound, "not_found")
	expect(t, "bob skips", do(http.MethodPost, base+"/skip", nil, bob), http.StatusNotFound, "not_found")
	expect(t, "approve without cycle", do(http.MethodPost, base+"/approve", nil, alice), http.StatusConflict, "no_active_cycle")
	w = do(http.MethodGet, base, nil, alice)
	expect(t, "still queued", w, http.StatusOK, "")
	if o := decode[api.ScheduledTransaction](t, w); o.State != api.ScheduledTransactionStateQueued || o.Overdue {
		t.Errorf("still queued %+v", o)
	}
	// Edited without the bucket line, it's recorded now.
	w = do(http.MethodPost, base+"/approve", map[string]any{"type": "EXP", "account_id": main, "amount": "8500", "counterparty": "Landlord"}, alice)
	expect(t, "approve edited", w, http.StatusOK, "")
	approved := decode[api.ApprovedScheduledTransaction](t, w)
	if approved.ScheduledTransaction.State != api.ScheduledTransactionStateApplied || approved.Transaction.ScheduleId.MustGet() != exp.Id ||
		approved.ScheduledTransaction.TransactionId.MustGet() != approved.Transaction.Id || !approved.Transaction.At.Equal(now) {
		t.Errorf("approved %+v", approved)
	}
	expect(t, "approve again", do(http.MethodPost, base+"/approve", nil, alice), http.StatusConflict, "already_resolved")
	expect(t, "skip approved", do(http.MethodPost, base+"/skip", nil, alice), http.StatusConflict, "already_resolved")

	// What's coming up: the transfer on the 25th, and the next expense.
	w = do(http.MethodGet, "/api/v1/upcoming-transactions?count=2", nil, alice)
	expect(t, "upcoming all", w, http.StatusOK, "")
	if got := decode[[]api.UpcomingTransaction](t, w); len(got) != 2 || got[0].ScheduleId != exp.Id ||
		!got[0].At.Equal(now.AddDate(0, 0, 14)) || got[1].ScheduleId != sch.Id {
		t.Errorf("upcoming all %+v", got)
	}
	expect(t, "upcoming all count", do(http.MethodGet, "/api/v1/upcoming-transactions?count=0", nil, alice), http.StatusBadRequest, "invalid_request")

	// Recorded first: a transfer from 09:00 today, recorded now and linked.
	first := map[string]any{
		"transaction": map[string]any{"type": "TRF", "account_id": main, "to_account_id": savings, "amount": "100"},
		"mode":        "auto", "start_date": "2026-11-08", "time": "09:00", "frequency": "week",
	}
	w = do(http.MethodPost, "/api/v1/schedules?record_first=true", first, alice)
	expect(t, "record first", w, http.StatusCreated, "")
	rec := decode[api.Schedule](t, w)
	if rec.NextIndex != 1 || !rec.NextAt.MustGet().Equal(time.Date(2026, 11, 15, 9, 0, 0, 0, time.UTC)) {
		t.Errorf("recorded first %+v", rec)
	}
	w = do(http.MethodGet, "/api/v1/scheduled-transactions?schedule_id="+rec.Id, nil, alice)
	expect(t, "recorded", w, http.StatusOK, "")
	page = decode[api.ScheduledTransactionPage](t, w)
	if len(page.Items) != 1 || page.Items[0].State != api.ScheduledTransactionStateApplied {
		t.Fatalf("recorded %+v", page)
	}
	w = do(http.MethodGet, "/api/v1/transactions/"+page.Items[0].TransactionId.MustGet(), nil, alice)
	expect(t, "recorded transaction", w, http.StatusOK, "")
	if tx := decode[api.Transaction](t, w); tx.ScheduleId.IsNull() || tx.ScheduleId.MustGet() != rec.Id ||
		!tx.At.Equal(time.Date(2026, 11, 8, 9, 0, 0, 0, time.UTC)) {
		t.Errorf("recorded transaction %+v", tx)
	}
	// Bob's account: nothing saved.
	first["transaction"].(map[string]any)["to_account_id"] = bobs
	expect(t, "record first bob's", do(http.MethodPost, "/api/v1/schedules?record_first=true", first, alice), http.StatusBadRequest, "")

	// A preview of a repeat that isn't saved.
	w = do(http.MethodPost, "/api/v1/schedules/preview", map[string]any{
		"start_date": "2026-08-31", "time": "08:00", "time_zone": "Europe/Oslo", "frequency": "month", "count": 2,
	}, alice)
	expect(t, "preview", w, http.StatusOK, "")
	if got := decode[[]time.Time](t, w); len(got) != 2 || !got[0].Equal(time.Date(2026, 11, 30, 7, 0, 0, 0, time.UTC)) ||
		!got[1].Equal(time.Date(2026, 12, 31, 7, 0, 0, 0, time.UTC)) {
		t.Errorf("preview %v", got)
	}
	for name, body := range map[string]map[string]any{
		"preview count":     {"start_date": "2026-08-31", "time": "08:00", "frequency": "month", "count": 51},
		"preview frequency": {"start_date": "2026-08-31", "time": "08:00", "frequency": "fortnight"},
		"preview time":      {"start_date": "2026-08-31", "time": "8", "frequency": "day"},
		"preview ends":      {"start_date": "2026-08-31", "time": "08:00", "frequency": "day", "end_count": 2, "end_date": "2026-09-30"},
	} {
		expect(t, name, do(http.MethodPost, "/api/v1/schedules/preview", body, alice), http.StatusBadRequest, "invalid_request")
	}
	expect(t, "preview no session", do(http.MethodPost, "/api/v1/schedules/preview", map[string]any{}, nil), http.StatusUnauthorized, "unauthenticated")

	// Paused and moved to 09:00.
	transfer["paused"], transfer["time"] = true, "09:00"
	w = do(http.MethodPut, "/api/v1/schedules/"+sch.Id, transfer, alice)
	expect(t, "update", w, http.StatusOK, "")
	if got := decode[api.Schedule](t, w); !got.Paused || got.Time != "09:00" || !got.NextAt.MustGet().Equal(time.Date(2026, 11, 25, 8, 0, 0, 0, time.UTC)) {
		t.Errorf("updated %+v", got)
	}
	expect(t, "update bob's", do(http.MethodPut, "/api/v1/schedules/"+sch.Id, transfer, bob), http.StatusNotFound, "not_found")

	expect(t, "delete", do(http.MethodDelete, "/api/v1/schedules/"+exp.Id, nil, alice), http.StatusNoContent, "")
	expect(t, "deleted", do(http.MethodGet, "/api/v1/schedules/"+exp.Id, nil, alice), http.StatusNotFound, "not_found")
	w = do(http.MethodGet, "/api/v1/scheduled-transactions?schedule_id="+exp.Id, nil, alice)
	expect(t, "after delete", w, http.StatusOK, "")
	if page := decode[api.ScheduledTransactionPage](t, w); len(page.Items) != 0 {
		t.Errorf("left %+v", page)
	}
}
