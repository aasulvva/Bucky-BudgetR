package httpapi_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/allocation"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/savings"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// TestSavingsDistributorAPI: the distributor, its rules and splits (#232).
func TestSavingsDistributorAPI(t *testing.T) {
	pool := testdb.New(t)
	authSvc := auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge})
	l := ledger.New(ledger.Options{AfterRecord: allocation.AfterRecord})
	sv := savings.NewService(pool, l, savings.Options{})
	h := newHandler(t, discard(), pool, httpapi.Options{
		Auth:         authSvc,
		Accounts:     accounts.NewService(pool, l, accounts.Options{Savings: sv}),
		Savings:      sv,
		Transactions: transactions.NewService(pool, l, transactions.Options{}),
	})
	authtest.NewUser(t, pool, "alice")
	alice := authtest.Login(t, h, "alice")
	do := func(method, path string, body any) *httptest.ResponseRecorder {
		t.Helper()
		return authtest.Do(t, h, method, path, body, alice)
	}
	account := func(name, typ, opening string) api.Account {
		t.Helper()
		w := do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": name, "type": typ, "opening_balance": opening})
		expect(t, "create "+name, w, http.StatusCreated, "")
		return decode[api.Account](t, w)
	}
	main, buffer, home := account("Main", "usage", "1000.00"), account("Buffer", "savings", "0.00"), account("Home", "bsu", "0.00")
	target := func(a api.Account, goal string) api.SavingsTarget {
		t.Helper()
		w := do(http.MethodPost, "/api/v1/savings/targets", map[string]any{"account_id": a.Id, "goal": goal})
		expect(t, "target "+a.Name, w, http.StatusCreated, "")
		return decode[api.SavingsTarget](t, w)
	}
	bt, ht := target(buffer, "5000.00"), target(home, "5000.00")

	w := do(http.MethodGet, "/api/v1/savings/distributor", nil)
	expect(t, "get", w, http.StatusOK, "")
	if d := decode[api.SavingsDistributor](t, w); d.Id.IsSpecified() && !d.Id.IsNull() || d.HoldMode != api.SavingsHoldModeImmediate {
		t.Errorf("before use %+v", d)
	}

	w = do(http.MethodPost, "/api/v1/savings/rules", map[string]any{"target_id": bt.Id, "from": "0.00", "to": "1000.00", "priority": 1})
	expect(t, "rule", w, http.StatusCreated, "")
	rule := decode[api.SavingsRule](t, w)
	if rule.To.MustGet() != "1000.00" || rule.PastGoal {
		t.Errorf("rule %+v", rule)
	}
	expect(t, "an overlap", do(http.MethodPost, "/api/v1/savings/rules", map[string]any{"target_id": bt.Id, "from": "500.00", "priority": 2}),
		http.StatusConflict, "rule_overlap")
	expect(t, "priority 7", do(http.MethodPost, "/api/v1/savings/rules", map[string]any{"target_id": ht.Id, "from": "0.00", "priority": 7}),
		http.StatusBadRequest, "")
	expect(t, "home's rule", do(http.MethodPost, "/api/v1/savings/rules", map[string]any{"target_id": ht.Id, "from": "0.00", "priority": 3}),
		http.StatusCreated, "")
	w = do(http.MethodPatch, "/api/v1/savings/rules/"+rule.Id, map[string]any{"from": "0.00", "to": nil, "priority": 1})
	expect(t, "open the end", w, http.StatusOK, "")
	if r := decode[api.SavingsRule](t, w); !r.To.IsNull() {
		t.Errorf("after opening its end %+v", r)
	}

	expect(t, "over unallocated", do(http.MethodPost, "/api/v1/savings/distributor/add", map[string]any{"account_id": main.Id, "amount": "1000.01"}),
		http.StatusConflict, "not_enough_unallocated")
	w = do(http.MethodGet, "/api/v1/savings/distributor/preview?account_id="+main.Id+"&amount=400.00", nil)
	expect(t, "preview", w, http.StatusOK, "")
	if p := decode[api.SavingsPreview](t, w); len(p.Shares) != 2 || p.Left != "0.00" || p.Shares[0].Amount != "100.00" || p.Shares[1].Amount != "300.00" {
		t.Errorf("preview %+v", p)
	}
	w = do(http.MethodPost, "/api/v1/savings/distributor/add", map[string]any{"account_id": main.Id, "amount": "400.00"})
	expect(t, "add", w, http.StatusOK, "")
	if got := decode[api.SavingsDistribution](t, w); len(got.Distributed) != 1 || len(got.Distributor.Held) != 0 {
		t.Errorf("added %+v", got)
	}

	expect(t, "minimum without an amount", do(http.MethodPatch, "/api/v1/savings/distributor", map[string]any{"hold_mode": "minimum"}),
		http.StatusBadRequest, "invalid_request")
	expect(t, "manual", do(http.MethodPatch, "/api/v1/savings/distributor", map[string]any{"hold_mode": "manual"}), http.StatusOK, "")
	w = do(http.MethodPost, "/api/v1/savings/distributor/add", map[string]any{"account_id": main.Id, "amount": "100.00"})
	if got := decode[api.SavingsDistribution](t, w); len(got.Distributed) != 0 || len(got.Distributor.Held) != 1 || got.Distributor.Held[0].Amount != "100.00" {
		t.Errorf("added in manual mode %+v", got)
	}
	expect(t, "clear too much", do(http.MethodPost, "/api/v1/savings/distributor/clear", map[string]any{"account_id": main.Id, "amount": "100.01"}),
		http.StatusConflict, "not_enough_held")
	expect(t, "clear", do(http.MethodPost, "/api/v1/savings/distributor/clear", map[string]any{"account_id": main.Id, "amount": "40.00"}),
		http.StatusOK, "")
	w = do(http.MethodPost, "/api/v1/savings/distributor/distribute", map[string]any{})
	expect(t, "distribute", w, http.StatusOK, "")
	if got := decode[api.SavingsDistribution](t, w); len(got.Distributed) != 1 || len(got.Distributor.Held) != 0 {
		t.Errorf("distributed %+v", got)
	}

	expect(t, "delete rule", do(http.MethodDelete, "/api/v1/savings/rules/"+rule.Id, nil), http.StatusNoContent, "")
	expect(t, "delete it again", do(http.MethodDelete, "/api/v1/savings/rules/"+rule.Id, nil), http.StatusNotFound, "not_found")
	w = do(http.MethodGet, "/api/v1/savings/rules", nil)
	if rules := decode[[]api.SavingsRule](t, w); len(rules) != 1 || rules[0].TargetId != ht.Id {
		t.Errorf("rules %+v", rules)
	}
}

// TestBucketOverflowTargetAPI: a bucket's overflow can go to a savings target
// in its currency (#233), and goes to the distributor once that target goes.
func TestBucketOverflowTargetAPI(t *testing.T) {
	pool := testdb.New(t)
	l := ledger.New(ledger.Options{AfterRecord: allocation.AfterRecord})
	sv := savings.NewService(pool, l, savings.Options{})
	h := newHandler(t, discard(), pool, httpapi.Options{
		Auth:     auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge}),
		Accounts: accounts.NewService(pool, l, accounts.Options{Savings: sv}),
		Buckets:  buckets.NewService(pool, l, buckets.Options{ReleaseSavings: sv.ReleaseBucket}),
		Savings:  sv,
	})
	authtest.NewUser(t, pool, "alice")
	alice := authtest.Login(t, h, "alice")
	do := func(method, path string, body any) *httptest.ResponseRecorder {
		t.Helper()
		return authtest.Do(t, h, method, path, body, alice)
	}
	account := func(body map[string]any) api.Account {
		t.Helper()
		w := do(http.MethodPost, "/api/v1/accounts", body)
		expect(t, "create account", w, http.StatusCreated, "")
		return decode[api.Account](t, w)
	}
	main := account(map[string]any{"name": "Main", "opening_balance": "1000.00"})
	buffer := account(map[string]any{"name": "Buffer", "type": "savings"})
	euro := account(map[string]any{"name": "Euro", "type": "savings", "currency": "EUR"})
	target := func(a api.Account) api.SavingsTarget {
		t.Helper()
		w := do(http.MethodPost, "/api/v1/savings/targets", map[string]any{"account_id": a.Id, "goal": "5000.00"})
		expect(t, "target "+a.Name, w, http.StatusCreated, "")
		return decode[api.SavingsTarget](t, w)
	}
	bt, et := target(buffer), target(euro)

	bucket := map[string]any{
		"name": "Food", "source_account_id": main.Id, "refill_amount": "100.00",
		"overflow_destination": "savings_target", "overflow_target_id": bt.Id,
	}
	w := do(http.MethodPost, "/api/v1/buckets", bucket)
	expect(t, "create", w, http.StatusCreated, "")
	b := decode[api.Bucket](t, w)
	if b.OverflowDestination != api.OverflowDestinationSavingsTarget || b.OverflowTargetId.MustGet() != bt.Id {
		t.Errorf("created %+v", b)
	}

	bucket["name"], bucket["overflow_target_id"] = "Fuel", et.Id
	expect(t, "another currency", do(http.MethodPost, "/api/v1/buckets", bucket), http.StatusBadRequest, "invalid_request")
	delete(bucket, "overflow_target_id")
	expect(t, "no target", do(http.MethodPost, "/api/v1/buckets", bucket), http.StatusBadRequest, "invalid_request")

	w = do(http.MethodPatch, "/api/v1/buckets/"+b.Id, map[string]any{"overflow_destination": "savings_distribution"})
	expect(t, "to the distributor", w, http.StatusOK, "")
	if got := decode[api.Bucket](t, w); got.OverflowDestination != api.OverflowDestinationSavingsDistribution || !got.OverflowTargetId.IsNull() {
		t.Errorf("updated %+v", got)
	}
	w = do(http.MethodPatch, "/api/v1/buckets/"+b.Id, map[string]any{"overflow_destination": "savings_target", "overflow_target_id": bt.Id})
	expect(t, "back to the target", w, http.StatusOK, "")

	expect(t, "delete the target", do(http.MethodDelete, "/api/v1/savings/targets/"+bt.Id, nil), http.StatusNoContent, "")
	w = do(http.MethodGet, "/api/v1/buckets/"+b.Id, nil)
	expect(t, "get", w, http.StatusOK, "")
	if got := decode[api.Bucket](t, w); got.OverflowDestination != api.OverflowDestinationSavingsDistribution || !got.OverflowTargetId.IsNull() {
		t.Errorf("after the target went %+v", got)
	}
}
