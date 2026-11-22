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
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledgertest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/savings"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

// TestSavingsBudgetAPI: the savings budget's fixed amounts (#234).
func TestSavingsBudgetAPI(t *testing.T) {
	pool := testdb.New(t)
	l := ledger.New(ledger.Options{AfterRecord: allocation.AfterRecord})
	sv := savings.NewService(pool, l, savings.Options{})
	h := newHandler(t, discard(), pool, httpapi.Options{
		Auth:     auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge}),
		Accounts: accounts.NewService(pool, l, accounts.Options{Savings: sv}),
		Savings:  sv,
	})
	user := authtest.NewUser(t, pool, "alice").ID
	alice := authtest.Login(t, h, "alice")
	now := time.Now()
	ledgertest.Cycle(t, pool, user, now.Add(-24*time.Hour), now.Add(30*24*time.Hour), "active")
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
	w := do(http.MethodPost, "/api/v1/savings/targets", map[string]any{"account_id": buffer.Id, "goal": "5000.00"})
	expect(t, "target", w, http.StatusCreated, "")
	target := decode[api.SavingsTarget](t, w)

	w = do(http.MethodPost, "/api/v1/savings/budget", map[string]any{
		"account_id": main.Id, "target_id": target.Id, "amount": "200.00", "when": "manual",
	})
	expect(t, "create", w, http.StatusCreated, "")
	e := decode[api.SavingsBudgetEntry](t, w)
	if e.TargetId.MustGet() != target.Id || e.Amount != "200.00" || e.When != api.SavingsBudgetWhenManual || !e.ThisCycle.IsNull() {
		t.Errorf("created %+v", e)
	}
	expect(t, "its own account", do(http.MethodPost, "/api/v1/savings/budget", map[string]any{
		"account_id": buffer.Id, "target_id": target.Id, "amount": "1.00", "when": "manual",
	}), http.StatusBadRequest, "invalid_request")
	expect(t, "unknown target", do(http.MethodPost, "/api/v1/savings/budget", map[string]any{
		"account_id": main.Id, "target_id": "9999999999", "amount": "1.00", "when": "manual",
	}), http.StatusNotFound, "not_found")

	w = do(http.MethodPost, "/api/v1/savings/budget/"+e.Id+"/save-now", nil)
	expect(t, "save now", w, http.StatusOK, "")
	if run := decode[api.SavingsBudgetEntry](t, w).ThisCycle.MustGet(); run.Reserved != "200.00" || run.At.IsNull() {
		t.Errorf("saved %+v", run)
	}
	expect(t, "save again", do(http.MethodPost, "/api/v1/savings/budget/"+e.Id+"/save-now", nil), http.StatusConflict, "already_saved")

	// To the distributor, at cycle start, waiting for the next cycle.
	w = do(http.MethodPatch, "/api/v1/savings/budget/"+e.Id, map[string]any{"target_id": nil, "when": "on_income"})
	expect(t, "to the distributor", w, http.StatusOK, "")
	if got := decode[api.SavingsBudgetEntry](t, w); !got.TargetId.IsNull() || got.When != api.SavingsBudgetWhenOnIncome {
		t.Errorf("updated %+v", got)
	}
	w = do(http.MethodPost, "/api/v1/savings/budget", map[string]any{
		"account_id": main.Id, "amount": "50.00", "when": "cycle_start", "this_cycle": false,
	})
	expect(t, "cycle start, next cycle", w, http.StatusCreated, "")
	if run := decode[api.SavingsBudgetEntry](t, w).ThisCycle.MustGet(); run.Wanted != "0.00" {
		t.Errorf("waiting %+v", run)
	}
	expect(t, "save an On income entry", do(http.MethodPost, "/api/v1/savings/budget/"+e.Id+"/save-now", nil),
		http.StatusBadRequest, "invalid_request")

	expect(t, "delete", do(http.MethodDelete, "/api/v1/savings/budget/"+e.Id, nil), http.StatusNoContent, "")
	expect(t, "delete again", do(http.MethodDelete, "/api/v1/savings/budget/"+e.Id, nil), http.StatusNotFound, "not_found")
	w = do(http.MethodGet, "/api/v1/savings/budget", nil)
	expect(t, "list", w, http.StatusOK, "")
	if list := decode[[]api.SavingsBudgetEntry](t, w); len(list) != 1 {
		t.Errorf("listed %+v", list)
	}
}
