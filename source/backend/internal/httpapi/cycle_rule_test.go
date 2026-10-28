package httpapi_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cycles"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

func TestCycleRuleAPI(t *testing.T) {
	pool := testdb.New(t)
	now := time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)
	h := newHandler(t, discard(), pool, httpapi.Options{
		Auth:   auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge}),
		Cycles: cycles.NewService(pool, cycles.Options{Now: func() time.Time { return now }}),
	})
	authtest.NewUser(t, pool, "alice")
	alice := authtest.Login(t, h, "alice")
	prefs := func(what string, body map[string]any, status int, code string) {
		t.Helper()
		expect(t, what, authtest.Do(t, h, http.MethodPatch, "/api/v1/me/preferences", body, alice), status, code)
	}
	rule := map[string]any{"day": 25, "shift": "previous", "holidays": "NO", "ahead": 3}

	prefs("a rule without a time zone", map[string]any{"cycle_rule": rule}, http.StatusBadRequest, "invalid_request")
	prefs("an unknown time zone", map[string]any{"time_zone": "Mars/Olympus"}, http.StatusBadRequest, "invalid_request")
	prefs("day 0", map[string]any{"time_zone": "Europe/Oslo", "cycle_rule": map[string]any{"day": 0, "shift": "previous", "holidays": "NO", "ahead": 3}},
		http.StatusBadRequest, "invalid_request")
	prefs("save the rule", map[string]any{"time_zone": "Europe/Oslo", "cycle_rule": rule}, http.StatusOK, "")

	// Saving it planned the cycles.
	list := decode[[]api.Cycle](t, authtest.Do(t, h, http.MethodGet, "/api/v1/cycles", nil, alice))
	if len(list) != 3 || !list[0].Generated || !list[0].StartAt.Equal(time.Date(2026, 8, 24, 22, 0, 0, 0, time.UTC)) {
		t.Errorf("cycles %+v", list)
	}
	prefs("removing the rule's time zone", map[string]any{"time_zone": nil}, http.StatusBadRequest, "invalid_request")

	w := authtest.Do(t, h, http.MethodPost, "/api/v1/cycle-rule/periods", map[string]any{"rule": rule, "from": "2026-12-01", "count": 2}, alice)
	expect(t, "periods", w, http.StatusOK, "")
	periods := decode[[]api.CyclePeriod](t, w)
	if len(periods) != 2 || periods[0].Start.String() != "2026-11-25" || periods[0].End.String() != "2026-12-22" ||
		periods[1].Start.String() != "2026-12-23" || periods[1].End.String() != "2027-01-24" {
		t.Errorf("periods %+v", periods)
	}
	expect(t, "too many periods", authtest.Do(t, h, http.MethodPost, "/api/v1/cycle-rule/periods",
		map[string]any{"rule": rule, "count": 13}, alice), http.StatusBadRequest, "invalid_request")
}
