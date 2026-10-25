package httpapi_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

func accountsHandler(t *testing.T) (http.Handler, *http.Cookie, *http.Cookie) {
	t.Helper()
	pool := testdb.New(t)
	authSvc := auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge})
	h := newHandler(t, discard(), pool, httpapi.Options{
		Auth:     authSvc,
		Accounts: accounts.NewService(pool, ledger.New(ledger.Options{}), accounts.Options{}),
	})
	authtest.NewUser(t, pool, "alice")
	authtest.NewUser(t, pool, "bob")
	return h, authtest.Login(t, h, "alice"), authtest.Login(t, h, "bob")
}

func decode[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.NewDecoder(w.Body).Decode(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

// expect checks the status and, for problems, the code.
func expect(t *testing.T, what string, w *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("%s: status %d, want %d: %s", what, w.Code, status, w.Body)
	}
	if code != "" {
		p := decode[api.Problem](t, w)
		if p.Code == nil || *p.Code != code {
			t.Errorf("%s: problem %+v, want code %s", what, p, code)
		}
	}
}

func TestAccountsAPI(t *testing.T) {
	h, alice, bob := accountsHandler(t)
	do := func(method, path string, body any, c *http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		return authtest.Do(t, h, method, path, body, c)
	}

	expect(t, "no session", do(http.MethodGet, "/api/v1/accounts", nil, nil), http.StatusUnauthorized, "unauthenticated")

	w := do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": "Main", "type": "usage", "opening_balance": "1500.50"}, alice)
	expect(t, "create", w, http.StatusCreated, "")
	main := decode[api.Account](t, w)
	if main.Name != "Main" || main.Balance != "1500.50" || main.Currency != "NOK" || main.Type != api.Usage {
		t.Errorf("created %+v", main)
	}
	w = do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": "Buffer", "type": "savings"}, alice)
	expect(t, "create second", w, http.StatusCreated, "")
	buffer := decode[api.Account](t, w)
	if buffer.Balance != "0.00" {
		t.Errorf("empty balance %q, want 0.00", buffer.Balance)
	}

	expect(t, "name taken", do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": "main"}, alice), http.StatusConflict, "name_taken")
	expect(t, "unknown field", do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": "x", "colour": "red"}, alice), http.StatusBadRequest, "invalid_request")
	expect(t, "3 decimals", do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": "x", "opening_balance": "1.005"}, alice), http.StatusBadRequest, "invalid_request")
	expect(t, "bad ID", do(http.MethodGet, "/api/v1/accounts/12", nil, alice), http.StatusBadRequest, "invalid_request")

	w = do(http.MethodGet, "/api/v1/accounts", nil, alice)
	expect(t, "list", w, http.StatusOK, "")
	if list := decode[[]api.Account](t, w); len(list) != 2 || list[0].Name != "Buffer" || list[1].Name != "Main" {
		t.Errorf("list %+v", list)
	}

	path := "/api/v1/accounts/" + main.Id
	w = do(http.MethodPatch, path, map[string]any{"name": "Everyday"}, alice)
	expect(t, "rename", w, http.StatusOK, "")
	if a := decode[api.Account](t, w); a.Name != "Everyday" || a.Balance != "1500.50" {
		t.Errorf("renamed %+v", a)
	}

	w = do(http.MethodPost, path+"/balance-adjustment", map[string]any{"target_balance": "1400"}, alice)
	expect(t, "adjust", w, http.StatusOK, "")
	if a := decode[api.Account](t, w); a.Balance != "1400.00" {
		t.Errorf("adjusted balance %q, want 1400.00", a.Balance)
	}
	expect(t, "adjust, no change", do(http.MethodPost, path+"/balance-adjustment", map[string]any{"target_balance": "1400.00"}, alice), http.StatusBadRequest, "no_change")

	// Bob can't see or touch alice's account.
	expect(t, "bob gets", do(http.MethodGet, path, nil, bob), http.StatusNotFound, "not_found")
	expect(t, "bob renames", do(http.MethodPatch, path, map[string]any{"name": "Mine"}, bob), http.StatusNotFound, "not_found")
	expect(t, "bob adjusts", do(http.MethodPost, path+"/balance-adjustment", map[string]any{"target_balance": "0"}, bob), http.StatusNotFound, "not_found")
	expect(t, "bob deletes", do(http.MethodPost, path+"/delete", nil, bob), http.StatusNotFound, "not_found")
	w = do(http.MethodGet, "/api/v1/accounts", nil, bob)
	expect(t, "bob lists", w, http.StatusOK, "")
	if list := decode[[]api.Account](t, w); len(list) != 0 {
		t.Errorf("bob sees %+v", list)
	}

	expect(t, "delete with money", do(http.MethodPost, path+"/delete", nil, alice), http.StatusConflict, "balance_not_zero")
	expect(t, "transfer without target", do(http.MethodPost, path+"/delete",
		map[string]any{"remaining_funds": map[string]any{"action": "transfer"}}, alice), http.StatusBadRequest, "invalid_request")
	expect(t, "delete with transfer", do(http.MethodPost, path+"/delete",
		map[string]any{"remaining_funds": map[string]any{"action": "transfer", "to_account_id": buffer.Id}}, alice), http.StatusNoContent, "")
	expect(t, "get deleted", do(http.MethodGet, path, nil, alice), http.StatusNotFound, "not_found")

	w = do(http.MethodGet, "/api/v1/accounts/"+buffer.Id, nil, alice)
	expect(t, "get target", w, http.StatusOK, "")
	if a := decode[api.Account](t, w); a.Balance != "1400.00" {
		t.Errorf("target balance %q, want 1400.00", a.Balance)
	}
}
