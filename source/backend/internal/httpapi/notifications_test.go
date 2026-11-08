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
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/notifications"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/schedules"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

func TestNotificationsAPI(t *testing.T) {
	pool := testdb.New(t)
	l := ledger.New(ledger.Options{})
	now := time.Date(2026, 11, 8, 10, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	tx := transactions.NewService(pool, l, transactions.Options{Now: clock})
	sch := schedules.NewService(pool, schedules.Options{Now: clock, Transactions: tx})
	bk := buckets.NewService(pool, l, buckets.Options{Now: clock})
	h := newHandler(t, discard(), pool, httpapi.Options{
		Auth:          auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge}),
		Accounts:      accounts.NewService(pool, l, accounts.Options{Now: clock}),
		Buckets:       bk,
		Transactions:  tx,
		Schedules:     sch,
		Notifications: notifications.NewService(pool, notifications.Options{Now: clock, Schedules: sch, Buckets: bk}),
	})
	authtest.NewUser(t, pool, "alice")
	authtest.NewUser(t, pool, "bob")
	alice, bob := authtest.Login(t, h, "alice"), authtest.Login(t, h, "bob")
	do := func(method, path string, body any, c *http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		return authtest.Do(t, h, method, path, body, c)
	}

	expect(t, "no session", do(http.MethodGet, "/api/v1/notifications", nil, nil), http.StatusUnauthorized, "unauthenticated")
	w := do(http.MethodGet, "/api/v1/notifications", nil, alice)
	expect(t, "none", w, http.StatusOK, "")
	if got := decode[api.NotificationList](t, w).Items; len(got) != 0 {
		t.Fatalf("none = %+v", got)
	}

	w = do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": "Main", "opening_balance": "10000"}, alice)
	expect(t, "create account", w, http.StatusCreated, "")
	main := decode[api.Account](t, w).Id
	// A bill tomorrow at 08:00 UTC.
	w = do(http.MethodPost, "/api/v1/schedules", map[string]any{
		"transaction": map[string]any{"type": "EXP", "account_id": main, "amount": "250.5"},
		"mode":        "auto", "start_date": "2026-11-09", "time": "08:00", "time_zone": "UTC", "frequency": "month",
	}, alice)
	expect(t, "create schedule", w, http.StatusCreated, "")
	id := decode[api.Schedule](t, w).Id

	w = do(http.MethodGet, "/api/v1/notifications", nil, alice)
	expect(t, "list", w, http.StatusOK, "")
	got := decode[api.NotificationList](t, w).Items
	if len(got) != 1 {
		t.Fatalf("list = %+v", got)
	}
	n := got[0]
	if n.Kind != api.UpcomingBill || n.Severity != api.Info || n.ScheduleId.MustGet() != id || n.AccountId.MustGet() != main ||
		n.Amount.MustGet() != "250.50" || n.Currency.MustGet() != "NOK" || !n.At.MustGet().Equal(time.Date(2026, 11, 9, 8, 0, 0, 0, time.UTC)) ||
		!n.Count.IsNull() || !n.BucketId.IsNull() || !n.CycleId.IsNull() {
		t.Errorf("bill = %+v", n)
	}

	expect(t, "bob dismissing", do(http.MethodPost, "/api/v1/notifications/dismiss", map[string]any{"key": n.Key}, bob), http.StatusNotFound, "not_found")
	expect(t, "empty key", do(http.MethodPost, "/api/v1/notifications/dismiss", map[string]any{"key": ""}, alice), http.StatusBadRequest, "invalid_request")
	expect(t, "dismiss", do(http.MethodPost, "/api/v1/notifications/dismiss", map[string]any{"key": n.Key}, alice), http.StatusNoContent, "")
	w = do(http.MethodGet, "/api/v1/notifications", nil, alice)
	if got := decode[api.NotificationList](t, w).Items; len(got) != 0 {
		t.Errorf("dismissed = %+v", got)
	}

	// The settings are checked.
	expect(t, "days", do(http.MethodPatch, "/api/v1/me/preferences", map[string]any{"notifications": map[string]any{"upcoming_days": 15}}, alice),
		http.StatusBadRequest, "invalid_request")
	w = do(http.MethodPatch, "/api/v1/me/preferences", map[string]any{"notifications": map[string]any{"upcoming_days": 7, "bucket_uncovered": false}}, alice)
	expect(t, "settings", w, http.StatusOK, "")
	if s := decode[api.Preferences](t, w).Notifications.MustGet(); s.UpcomingDays.MustGet() != 7 || s.BucketUncovered.MustGet() {
		t.Errorf("settings = %+v", s)
	}
}
