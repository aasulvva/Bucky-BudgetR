package httpapi_test

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// TestCounterpartyAPI checks graphs per counterparty and the exact filter (#170).
func TestCounterpartyAPI(t *testing.T) {
	pool := testdb.New(t)
	l := ledger.New(ledger.Options{})
	h := newHandler(t, discard(), pool, httpapi.Options{
		Auth:         auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge}),
		Accounts:     accounts.NewService(pool, l, accounts.Options{}),
		Transactions: transactions.NewService(pool, l, transactions.Options{}),
	})
	authtest.NewUser(t, pool, "alice")
	alice := authtest.Login(t, h, "alice")
	do := func(method, path string, body any) *httptest.ResponseRecorder {
		t.Helper()
		return authtest.Do(t, h, method, path, body, alice)
	}
	w := do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": "Main"})
	main := decode[api.Account](t, w).Id
	for _, cp := range []string{"Employer", "employer ", ""} {
		expect(t, "income", do(http.MethodPost, "/api/v1/transactions", map[string]any{
			"type": "INC", "account_id": main, "amount": "100", "counterparty": cp,
		}), http.StatusCreated, "")
	}

	q := url.Values{
		"metric": {"income"}, "resolution": {"total"}, "group_by": {"counterparty"},
		"from": {time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)},
		"to":   {time.Now().Add(time.Hour).UTC().Format(time.RFC3339)},
	}
	w = do(http.MethodGet, "/api/v1/stats/series?"+q.Encode(), nil)
	expect(t, "per counterparty", w, http.StatusOK, "")
	series := decode[api.StatsSeries](t, w).Series
	if len(series) != 2 || !strings.EqualFold(series[0].Counterparty.MustGet(), "employer") || series[0].Values[0] != "200.00" ||
		!series[1].Counterparty.IsNull() || series[1].Values[0] != "100.00" {
		t.Errorf("series %+v", series)
	}
	q.Set("metric", "balance")
	expect(t, "balance per counterparty", do(http.MethodGet, "/api/v1/stats/series?"+q.Encode(), nil), http.StatusBadRequest, "invalid_request")

	w = do(http.MethodGet, "/api/v1/transactions?counterparty_is=EMPLOYER", nil)
	expect(t, "exact", w, http.StatusOK, "")
	if items := decode[api.TransactionPage](t, w).Items; len(items) != 2 {
		t.Errorf("exact %+v", items)
	}
}
