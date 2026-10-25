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
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledgertest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/refill"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

func TestRefillsAPI(t *testing.T) {
	pool := testdb.New(t)
	l := ledger.New(ledger.Options{AfterRecord: allocation.AfterRecord})
	r := refill.NewService(pool, l, refill.Options{})
	h := newHandler(t, discard(), pool, httpapi.Options{
		Auth:         auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge}),
		Accounts:     accounts.NewService(pool, l, accounts.Options{}),
		Cycles:       cycles.NewService(pool, cycles.Options{OnEnd: r.OnEnd, OnStart: r.OnStart}),
		Buckets:      buckets.NewService(pool, l, buckets.Options{}),
		Transactions: transactions.NewService(pool, l, transactions.Options{Refills: r}),
		Refills:      r,
	})
	user := authtest.NewUser(t, pool, "alice").ID
	authtest.NewUser(t, pool, "bob")
	alice, bob := authtest.Login(t, h, "alice"), authtest.Login(t, h, "bob")
	now := time.Now()
	ledgertest.Cycle(t, pool, user, now.Add(-24*time.Hour), now.Add(30*24*time.Hour), "active")
	do := func(method, path string, body any, c *http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		return authtest.Do(t, h, method, path, body, c)
	}

	w := do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": "Main", "opening_balance": "10000"}, alice)
	expect(t, "create account", w, http.StatusCreated, "")
	acc := decode[api.Account](t, w).Id
	bucket := func(name, mode string) api.Bucket {
		t.Helper()
		w := do(http.MethodPost, "/api/v1/buckets", map[string]any{
			"name": name, "source_account_id": acc, "refill_amount": "500", "refill_mode": mode,
		}, alice)
		expect(t, "create "+name, w, http.StatusCreated, "")
		return decode[api.Bucket](t, w)
	}
	manual, auto, salary := bucket("Fun", "manual"), bucket("Rent", "auto"), bucket("Food", "on_income")
	if manual.Refilled {
		t.Errorf("new bucket refilled")
	}

	// Manual refill.
	path := "/api/v1/buckets/" + manual.Id + "/refill"
	w = do(http.MethodPost, path, nil, alice)
	expect(t, "refill", w, http.StatusOK, "")
	if b := decode[api.Bucket](t, w); !b.Refilled || b.TargetFunds != "500.00" {
		t.Errorf("refilled %+v", b)
	}
	expect(t, "refill twice", do(http.MethodPost, path, nil, alice), http.StatusConflict, "already_refilled")
	expect(t, "auto bucket", do(http.MethodPost, "/api/v1/buckets/"+auto.Id+"/refill", nil, alice), http.StatusConflict, "wrong_refill_mode")
	expect(t, "bob refills", do(http.MethodPost, path, nil, bob), http.StatusNotFound, "not_found")

	// Income rules in the preferences.
	w = do(http.MethodPatch, "/api/v1/me/preferences", map[string]any{
		"income_refill_rules": []map[string]any{{"counterparty": "Employer", "min_amount": "20000"}},
	}, alice)
	expect(t, "set rules", w, http.StatusOK, "")
	if p := decode[api.Preferences](t, w); len(p.IncomeRefillRules.MustGet()) != 1 {
		t.Errorf("preferences %+v", p)
	}
	for name, rules := range map[string]any{
		"negative minimum":    []map[string]any{{"counterparty": "Employer", "min_amount": "-1"}},
		"blank counterparty":  []map[string]any{{"counterparty": " ", "min_amount": "1"}},
		"missing min_amount":  []map[string]any{{"counterparty": "Employer"}},
		"unknown field":       []map[string]any{{"counterparty": "Employer", "min_amount": "1", "account_id": acc}},
		"not a list of rules": "Employer",
	} {
		expect(t, name, do(http.MethodPatch, "/api/v1/me/preferences", map[string]any{"income_refill_rules": rules}, alice),
			http.StatusBadRequest, "invalid_request")
	}

	w = do(http.MethodPost, "/api/v1/transactions", map[string]any{"type": "INC", "account_id": acc, "amount": "100", "counterparty": "Employer"}, alice)
	expect(t, "small income", w, http.StatusCreated, "")
	if tr := decode[api.Transaction](t, w); tr.TriggersRefill {
		t.Errorf("small income triggers %+v", tr)
	}
	w = do(http.MethodPost, "/api/v1/transactions", map[string]any{"type": "INC", "account_id": acc, "amount": "25000", "counterparty": "employer"}, alice)
	expect(t, "salary", w, http.StatusCreated, "")
	inc := decode[api.Transaction](t, w)
	if !inc.TriggersRefill {
		t.Errorf("salary doesn't trigger %+v", inc)
	}
	w = do(http.MethodGet, "/api/v1/buckets/"+salary.Id, nil, alice)
	if b := decode[api.Bucket](t, w); !b.Refilled || b.TargetFunds != "500.00" {
		t.Errorf("on income bucket %+v", b)
	}

	// Reversing it undoes the refill.
	expect(t, "reverse", do(http.MethodPost, "/api/v1/transactions/"+inc.Id+"/reversal", nil, alice), http.StatusOK, "")
	w = do(http.MethodGet, "/api/v1/buckets/"+salary.Id, nil, alice)
	if b := decode[api.Bucket](t, w); b.Refilled || b.TargetFunds != "0.00" {
		t.Errorf("after the reversal %+v", b)
	}

	// The flag, explicitly.
	expect(t, "EXP with the flag", do(http.MethodPost, "/api/v1/transactions",
		map[string]any{"type": "EXP", "account_id": acc, "amount": "1", "triggers_refill": true}, alice), http.StatusBadRequest, "invalid_request")
	expect(t, "income before the cycle", do(http.MethodPost, "/api/v1/transactions", map[string]any{
		"type": "INC", "account_id": acc, "amount": "1", "triggers_refill": true, "at": now.Add(-48 * time.Hour).Format(time.RFC3339),
	}, alice), http.StatusConflict, "refill_unavailable")
	w = do(http.MethodPost, "/api/v1/transactions", map[string]any{"type": "INC", "account_id": acc, "amount": "1"}, alice)
	expect(t, "gift", w, http.StatusCreated, "")
	gift := decode[api.Transaction](t, w)
	w = do(http.MethodPost, "/api/v1/transactions/"+gift.Id+"/correction", map[string]any{"triggers_refill": true}, alice)
	expect(t, "set the flag", w, http.StatusOK, "")
	if tr := decode[api.Transaction](t, w); !tr.TriggersRefill || !tr.Corrected {
		t.Errorf("corrected %+v", tr)
	}
	w = do(http.MethodGet, "/api/v1/buckets", nil, alice)
	for _, b := range decode[[]api.Bucket](t, w) {
		if b.Id != auto.Id && !b.Refilled {
			t.Errorf("bucket %s not refilled", b.Name)
		}
	}
}
