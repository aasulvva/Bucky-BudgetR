package httpapi_test

import (
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
)

// TestStatsCardPurchaseByBucket: grouped by bucket, a card purchase spent
// from a bucket on another account (#261) counts once: its bucket part in
// the bucket, the rest on no bucket. Filtered to the card, its buckets show.
func TestStatsCardPurchaseByBucket(t *testing.T) {
	w := newWaitingWorld(t, time.Date(2027, 1, 5, 10, 0, 0, 0, time.UTC))
	jan := w.cycle(time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(2027, 2, 1, 0, 0, 0, 0, time.UTC))
	w.ok("start January", http.MethodPost, "/api/v1/cycles/"+jan.Id+"/start", nil, http.StatusOK)
	main := decode[api.Account](t, w.ok("Main", http.MethodPost, "/api/v1/accounts",
		map[string]any{"name": "Main", "opening_balance": "10000", "opening_at": "2027-01-02T12:00:00Z"}, http.StatusCreated))
	visa := decode[api.Account](t, w.ok("Visa", http.MethodPost, "/api/v1/accounts", map[string]any{
		"name": "Visa", "type": "credit_card", "credit_card": map[string]any{"credit_limit": "5000", "statement_day": 1,
			"due_day": 15, "minimum_payment": "300", "default_account_id": main.Id},
	}, http.StatusCreated))
	groceries := decode[api.Bucket](t, w.ok("Groceries", http.MethodPost, "/api/v1/buckets", map[string]any{
		"name": "Groceries", "source_account_id": main.Id, "refill_amount": "4000", "refill_mode": "manual",
	}, http.StatusCreated))
	w.ok("refill Groceries", http.MethodPost, "/api/v1/buckets/"+groceries.Id+"/refill", nil, http.StatusOK)
	w.purchase("on the card", map[string]any{"account_id": visa.Id, "amount": "1000", "counterparty": "Shop",
		"bucket_lines": []map[string]any{{"bucket_id": groceries.Id, "amount": "600"}}}, http.StatusCreated, "")
	w.purchase("from Main", map[string]any{"account_id": main.Id, "amount": "50", "counterparty": "Kiosk"},
		http.StatusCreated, "")

	// The January spending per series: a bucket's ID, or "" for no bucket.
	spending := func(accounts ...string) map[string]string {
		t.Helper()
		q := url.Values{"metric": {"spending"}, "resolution": {"month"}, "group_by": {"bucket"}, "time_zone": {"UTC"},
			"from": {"2027-01-01T00:00:00Z"}, "to": {"2027-02-01T00:00:00Z"}}
		for _, a := range accounts {
			q.Add("account_id", a)
		}
		series := decode[api.StatsSeries](t, w.ok("stats", http.MethodGet, "/api/v1/stats/series?"+q.Encode(), nil, http.StatusOK))
		out := map[string]string{}
		for _, s := range series.Series {
			id, _ := s.BucketId.Get()
			if len(s.Values) != 1 {
				t.Fatalf("series %+v", s)
			}
			out[id] = s.Values[0]
		}
		return out
	}
	for _, c := range []struct {
		what                string
		accounts            []string
		groceries, noBucket string
	}{
		{"every account", nil, "600.00", "450.00"},
		{"the card", []string{visa.Id}, "600.00", "400.00"},
		{"Main", []string{main.Id}, "600.00", "50.00"},
		{"both", []string{main.Id, visa.Id}, "600.00", "450.00"},
	} {
		got := spending(c.accounts...)
		if got[groceries.Id] != c.groceries || got[""] != c.noBucket {
			t.Errorf("%s: %v", c.what, got)
		}
	}
}
