package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/logging"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

// The Logs screen (#93): errors with their request and user, admin actions
// as audit entries, filters and retention.
func TestLogsAPI(t *testing.T) {
	pool := testdb.New(t)
	store := logging.NewStore(slog.DiscardHandler)
	logger := store.Logger()
	store.Start(sqlc.New(pool))
	h := newHandler(t, logger, pool, httpapi.Options{
		Auth: auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge}),
		Logs: logging.NewService(pool, logger),
	})
	admin := authtest.NewUser(t, pool, "admin", authtest.Admin)
	c := authtest.Login(t, h, "admin")
	do := func(method, path string, body any) string {
		t.Helper()
		w := authtest.Do(t, h, method, path, body, c)
		if w.Code >= 400 && !strings.HasPrefix(path, "/api/v1/accounts") {
			t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body)
		}
		return w.Body.String()
	}

	// What an admin does is recorded, without the password or link.
	created := do(http.MethodPost, "/api/v1/admin/users", map[string]any{"username": "kari"})
	var kari api.CreatedUser
	decodeString(t, created, &kari)
	do(http.MethodPatch, "/api/v1/admin/users/"+kari.User.Id, map[string]any{"active": false, "admin": true})
	link := do(http.MethodPost, "/api/v1/admin/users/"+kari.User.Id+"/reset-password", map[string]any{"credential": "link"})
	var cred api.NewCredential
	decodeString(t, link, &cred)
	do(http.MethodPut, "/api/v1/admin/log-settings", map[string]any{"event_days": 10, "error_days": 90, "audit_days": 365})
	// A failing request is kept with its reference and user.
	w := authtest.Do(t, h, http.MethodGet, "/api/v1/accounts", nil, c)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("accounts without a service: %d", w.Code)
	}
	ref := w.Header().Get(httpapi.RequestIDHeader)

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := store.Close(ctx); err != nil {
		t.Fatal(err)
	}

	body := do(http.MethodGet, "/api/v1/admin/logs?kind=audit", nil)
	if strings.Contains(body, deref(kari.TemporaryPassword)) || strings.Contains(body, cred.Link.Token) {
		t.Errorf("the audit log has a password or link: %s", body)
	}
	page := decodeAs[api.LogPage](t, body)
	var events []string
	for _, e := range page.Entries {
		events = append(events, deref(e.Event))
		if e.Kind != api.Audit || deref(e.UserId) != admin.ID || deref(e.Username) != "admin" || deref(e.RequestId) == "" {
			t.Errorf("audit entry %+v", e)
		}
	}
	want := "logs.settings_changed,user.password_reset,user.admin_granted,user.deactivated,user.created"
	if strings.Join(events, ",") != want {
		t.Errorf("audit events %v, want %s", events, want)
	}
	if e := page.Entries[len(page.Entries)-1]; e.Attrs["target.username"] != "kari" || e.Attrs["credential"] != "password" {
		t.Errorf("user.created attrs %v", e.Attrs)
	}
	if e := page.Entries[0]; e.Attrs["old.event_days"] != float64(30) || e.Attrs["new.event_days"] != float64(10) {
		t.Errorf("settings attrs %v", e.Attrs)
	}

	page = decodeAs[api.LogPage](t, do(http.MethodGet, "/api/v1/admin/logs?request_id="+ref, nil))
	if len(page.Entries) != 2 {
		t.Fatalf("entries for the reference: %+v", page.Entries)
	}
	for _, e := range page.Entries {
		if e.Kind != api.Log || deref(e.UserId) != admin.ID {
			t.Errorf("error entry %+v", e)
		}
	}
	if access := page.Entries[0]; access.Level != api.LogEntryLevelError || access.Attrs["path"] != "/api/v1/accounts" ||
		access.Attrs["status"] != float64(503) {
		t.Errorf("access entry %+v", access)
	}

	page = decodeAs[api.LogPage](t, do(http.MethodGet, "/api/v1/admin/logs?min_level=error&q=ACCOUNTS", nil))
	if len(page.Entries) != 1 || page.Entries[0].Message != "request" {
		t.Errorf("errors about accounts: %+v", page.Entries)
	}

	// Pages follow next_before.
	var all []int64
	path := "/api/v1/admin/logs?limit=2&user_id=" + admin.ID
	for range 10 {
		page = decodeAs[api.LogPage](t, do(http.MethodGet, path, nil))
		for _, e := range page.Entries {
			all = append(all, e.Id)
		}
		if page.NextBefore == nil {
			break
		}
		path = fmt.Sprintf("/api/v1/admin/logs?limit=2&user_id=%s&before=%d", admin.ID, *page.NextBefore)
	}
	if len(all) != 7 {
		t.Errorf("paged through %d entries, want 7", len(all))
	}

	var st api.LogSettings
	decodeString(t, do(http.MethodGet, "/api/v1/admin/log-settings", nil), &st)
	if st != (api.LogSettings{EventDays: 10, ErrorDays: 90, AuditDays: 365}) {
		t.Errorf("settings %+v", st)
	}
	w = authtest.Do(t, h, http.MethodPut, "/api/v1/admin/log-settings", map[string]any{"event_days": 0, "error_days": 90, "audit_days": 365}, c)
	if w.Code != http.StatusBadRequest {
		t.Errorf("0 days: %d %s", w.Code, w.Body)
	}
}

func decodeString(t *testing.T, body string, v any) {
	t.Helper()
	if err := json.Unmarshal([]byte(body), v); err != nil {
		t.Fatalf("%v: %s", err, body)
	}
}

func decodeAs[T any](t *testing.T, body string) T {
	t.Helper()
	var v T
	decodeString(t, body, &v)
	return v
}
