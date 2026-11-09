package httpapi_test

import (
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
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// TestBankAPI checks an account's bank and renaming its interest to it (#70).
func TestBankAPI(t *testing.T) {
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

	w := do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": "Main", "bank": " DNB "})
	expect(t, "create with a bank", w, http.StatusCreated, "")
	main := decode[api.Account](t, w)
	if main.Bank != "DNB" {
		t.Errorf("bank %q", main.Bank)
	}
	w = do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": "Card"})
	if got := decode[api.Account](t, w); got.Bank != "" {
		t.Errorf("no bank %q", got.Bank)
	}
	w = do(http.MethodPatch, "/api/v1/accounts/"+main.Id, map[string]any{"bank": ""})
	expect(t, "clear", w, http.StatusOK, "")
	if got := decode[api.Account](t, w); got.Bank != "" {
		t.Errorf("cleared %q", got.Bank)
	}
	w = do(http.MethodPatch, "/api/v1/accounts/"+main.Id, map[string]any{"bank": "Sbanken"})
	if got := decode[api.Account](t, w); got.Bank != "Sbanken" {
		t.Errorf("set %q", got.Bank)
	}

	for range 2 {
		expect(t, "interest", do(http.MethodPost, "/api/v1/transactions", map[string]any{
			"type": "INC", "account_id": main.Id, "amount": "5", "counterparty": "Interest", "tags": []string{"interest"},
		}), http.StatusCreated, "")
	}
	rename := map[string]any{
		"account_id": main.Id, "type": "INC", "tag": "interest", "from": []string{"Interest", "Renter"}, "to": "Sbanken",
	}
	w = do(http.MethodPost, "/api/v1/transactions/counterparty-rename", rename)
	expect(t, "count", w, http.StatusOK, "")
	if got := decode[api.RenameCounterparty200JSONResponse](t, w); got.Count != 2 {
		t.Errorf("count %d", got.Count)
	}
	rename["apply"] = true
	w = do(http.MethodPost, "/api/v1/transactions/counterparty-rename", rename)
	if got := decode[api.RenameCounterparty200JSONResponse](t, w); got.Count != 2 {
		t.Errorf("applied %d", got.Count)
	}
	w = do(http.MethodGet, "/api/v1/transactions?counterparty=sbanken", nil)
	if got := decode[api.TransactionPage](t, w).Items; len(got) != 2 || got[0].Counterparty != "Sbanken" || !got[0].Corrected {
		t.Errorf("renamed %+v", got)
	}
	expect(t, "nothing to rename from", do(http.MethodPost, "/api/v1/transactions/counterparty-rename",
		map[string]any{"account_id": main.Id, "from": []string{}, "to": "X"}), http.StatusBadRequest, "invalid_request")
}
