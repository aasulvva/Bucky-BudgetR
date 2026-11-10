package httpapi_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
)

func TestStatsSeriesAPI(t *testing.T) {
	h, alice, _ := accountsHandler(t)
	do := func(path string, c *http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		return authtest.Do(t, h, http.MethodGet, path, nil, c)
	}
	expect(t, "create", authtest.Do(t, h, http.MethodPost, "/api/v1/accounts",
		map[string]any{"name": "Main", "type": "usage", "opening_balance": "1500"}, alice), http.StatusCreated, "")

	// The first three days of 2026 in Oslo, cut there.
	const days = "/api/v1/stats/series?metric=balance&from=2025-12-31T23:00:00Z&to=2026-01-03T23:00:00Z&resolution=day&time_zone=Europe/Oslo"
	expect(t, "no session", do(days, nil), http.StatusUnauthorized, "unauthenticated")
	w := do(days, alice)
	expect(t, "balance", w, http.StatusOK, "")
	var got struct {
		Intervals []struct{ Start, End string }
		Series    []struct {
			Currency string
			Values   []string
		}
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Intervals) != 3 || got.Intervals[0].Start != "2025-12-31T23:00:00Z" || got.Intervals[2].End != "2026-01-03T23:00:00Z" {
		t.Errorf("intervals = %+v", got.Intervals)
	}
	// The opening balance was entered now, after the period.
	if len(got.Series) != 1 || got.Series[0].Currency != "NOK" || !slices.Equal(got.Series[0].Values, []string{"0.00", "0.00", "0.00"}) {
		t.Errorf("series = %+v", got.Series)
	}
	expect(t, "spending by bucket", do("/api/v1/stats/series?metric=spending&from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z&resolution=week&week_start=7&group_by=bucket&tag=a&tag=b&counterparty=x", alice), http.StatusOK, "")

	const base = "/api/v1/stats/series?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z"
	for name, path := range map[string]string{
		"no metric":          base + "&resolution=day",
		"unknown metric":     base + "&metric=profit&resolution=day",
		"no resolution":      base + "&metric=spending",
		"unknown zone":       base + "&metric=spending&resolution=day&time_zone=Mars/Olympus",
		"local zone":         base + "&metric=spending&resolution=day&time_zone=Local",
		"week start 0":       base + "&metric=spending&resolution=week&week_start=0",
		"balance by bucket":  base + "&metric=balance&resolution=day&group_by=bucket",
		"balance with a tag": base + "&metric=balance&resolution=day&tag=x",
		"backwards":          "/api/v1/stats/series?metric=spending&resolution=day&from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z",
		"bad account":        base + "&metric=spending&resolution=day&account_id=12",
	} {
		expect(t, name, do(path, alice), http.StatusBadRequest, "invalid_request")
	}
	expect(t, "a year in hours", do("/api/v1/stats/series?metric=spending&resolution=hour&from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z", alice),
		http.StatusBadRequest, "too_many_intervals")
}

func TestStatsFlowsAPI(t *testing.T) {
	h, alice, _ := accountsHandler(t)
	do := func(path string, c *http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		return authtest.Do(t, h, http.MethodGet, path, nil, c)
	}
	expect(t, "create", authtest.Do(t, h, http.MethodPost, "/api/v1/accounts",
		map[string]any{"name": "Main", "type": "usage", "opening_balance": "1500"}, alice), http.StatusCreated, "")

	// 2026 by month in Oslo (#126); the service tests cover the sums.
	const year = "/api/v1/stats/flows?from=2025-12-31T23:00:00Z&to=2026-12-31T23:00:00Z&resolution=month&time_zone=Europe/Oslo"
	expect(t, "no session", do(year, nil), http.StatusUnauthorized, "unauthenticated")
	w := do(year, alice)
	expect(t, "flows", w, http.StatusOK, "")
	var got struct {
		Intervals []struct{ Start, End string }
		Buckets   []json.RawMessage
		Accounts  []struct {
			Currency string
			Values   []struct{ Income, Expenses string }
		}
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Intervals) != 12 || len(got.Buckets) != 0 || len(got.Accounts) != 1 || len(got.Accounts[0].Values) != 12 ||
		got.Accounts[0].Values[0].Income != "0.00" {
		t.Errorf("flows = %s", w.Body)
	}

	const base = "/api/v1/stats/flows?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z"
	for name, path := range map[string]string{
		"no resolution": base,
		"by day":        base + "&resolution=day",
		"unknown zone":  base + "&resolution=total&time_zone=Mars/Olympus",
		"backwards":     "/api/v1/stats/flows?resolution=total&from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z",
		"bad bucket":    base + "&resolution=total&bucket_id=12",
	} {
		expect(t, name, do(path, alice), http.StatusBadRequest, "invalid_request")
	}
}
