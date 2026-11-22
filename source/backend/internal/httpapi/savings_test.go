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
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledgertest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/savings"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// TestSavingsAPI: savings targets and their held funds (#231).
func TestSavingsAPI(t *testing.T) {
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
	user := authtest.NewUser(t, pool, "alice").ID
	alice := authtest.Login(t, h, "alice")
	authtest.NewUser(t, pool, "bob")
	bob := authtest.Login(t, h, "bob")
	do := func(method, path string, body any, c *http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		return authtest.Do(t, h, method, path, body, c)
	}
	account := func(name, typ, opening string) api.Account {
		t.Helper()
		w := do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": name, "type": typ, "opening_balance": opening}, alice)
		expect(t, "create "+name, w, http.StatusCreated, "")
		return decode[api.Account](t, w)
	}
	main, buffer := account("Main", "usage", "1000.00"), account("Buffer", "savings", "0.00")

	expect(t, "no session", do(http.MethodGet, "/api/v1/savings/targets", nil, nil), http.StatusUnauthorized, "unauthenticated")
	expect(t, "a usage account", do(http.MethodPost, "/api/v1/savings/targets", map[string]any{"account_id": main.Id, "goal": "100.00"}, alice),
		http.StatusBadRequest, "wrong_account_type")
	bucket := ledgertest.Bucket(t, pool, user, main.Id)
	expect(t, "an auto bucket", do(http.MethodPost, "/api/v1/savings/targets", map[string]any{"bucket_id": bucket, "goal": "100.00"}, alice),
		http.StatusBadRequest, "not_fully_manual")

	w := do(http.MethodPost, "/api/v1/savings/targets", map[string]any{"account_id": buffer.Id, "goal": "5000.00", "note": "Rainy day"}, alice)
	expect(t, "create", w, http.StatusCreated, "")
	target := decode[api.SavingsTarget](t, w)
	if target.Name != "Buffer" || target.CustomName.IsSpecified() && !target.CustomName.IsNull() || target.HeldTotal != "0.00" || target.Note != "Rainy day" {
		t.Errorf("created %+v", target)
	}
	expect(t, "again", do(http.MethodPost, "/api/v1/savings/targets", map[string]any{"account_id": buffer.Id, "goal": "1.00"}, alice),
		http.StatusConflict, "already_target")
	path := "/api/v1/savings/targets/" + target.Id
	expect(t, "bob's view", do(http.MethodGet, path, nil, bob), http.StatusNotFound, "not_found")

	w = do(http.MethodPatch, path, map[string]any{"name": "Rainy day fund"}, alice)
	expect(t, "rename", w, http.StatusOK, "")
	if got := decode[api.SavingsTarget](t, w); got.Name != "Rainy day fund" {
		t.Errorf("renamed %+v", got)
	}

	expect(t, "more than unallocated", do(http.MethodPost, path+"/add", map[string]any{"account_id": main.Id, "amount": "1000.01"}, alice),
		http.StatusConflict, "not_enough_unallocated")
	w = do(http.MethodPost, path+"/add", map[string]any{"account_id": main.Id, "amount": "300.00"}, alice)
	expect(t, "add", w, http.StatusOK, "")
	if got := decode[api.SavingsTarget](t, w); got.HeldTotal != "300.00" || len(got.Held) != 1 || got.Held[0].Covered != "300.00" {
		t.Errorf("after add %+v", got)
	}
	w = do(http.MethodGet, "/api/v1/accounts/"+main.Id, nil, alice)
	if a := decode[api.Account](t, w); a.Unallocated != "700.00" || a.Reserved != "300.00" || a.ReservedUncovered != "0.00" {
		t.Errorf("main %+v", a)
	}

	expect(t, "done more than held", do(http.MethodPost, path+"/done", map[string]any{"account_id": main.Id, "amount": "300.01"}, alice),
		http.StatusConflict, "not_enough_held")
	w = do(http.MethodPost, path+"/done", map[string]any{"account_id": main.Id, "amount": "100.00", "description": "Monthly"}, alice)
	expect(t, "done", w, http.StatusOK, "")
	if got := decode[api.SavingsTarget](t, w); got.HeldTotal != "200.00" || got.Current != "100.00" {
		t.Errorf("after done %+v", got)
	}

	// The transfer shows its savings line and keeps its amount.
	w = do(http.MethodGet, "/api/v1/transactions?type=TRF", nil, alice)
	expect(t, "list", w, http.StatusOK, "")
	page := decode[api.TransactionPage](t, w)
	if len(page.Items) != 1 || len(page.Items[0].SavingsLines) != 1 || page.Items[0].SavingsLines[0].Amount != "-100.00" {
		t.Fatalf("transfers %+v", page.Items)
	}
	trf := "/api/v1/transactions/" + page.Items[0].Id
	expect(t, "correct the amount", do(http.MethodPost, trf+"/correction", map[string]any{"amount": "150.00"}, alice),
		http.StatusConflict, "savings_transfer")
	expect(t, "correct the description", do(http.MethodPost, trf+"/correction", map[string]any{"description": "To Buffer"}, alice),
		http.StatusOK, "")

	w = do(http.MethodPost, path+"/clear", map[string]any{"account_id": main.Id, "amount": "200.00"}, alice)
	expect(t, "clear", w, http.StatusOK, "")
	if got := decode[api.SavingsTarget](t, w); got.HeldTotal != "0.00" || len(got.Held) != 0 {
		t.Errorf("after clear %+v", got)
	}

	expect(t, "delete", do(http.MethodDelete, path, nil, alice), http.StatusNoContent, "")
	w = do(http.MethodGet, "/api/v1/savings/targets", nil, alice)
	expect(t, "list after delete", w, http.StatusOK, "")
	if got := decode[[]api.SavingsTarget](t, w); len(got) != 0 {
		t.Errorf("targets after delete %+v", got)
	}

	// Without the service, 503.
	bare := newHandler(t, discard(), pool, httpapi.Options{Auth: authSvc})
	if w := authtest.Do(t, bare, http.MethodGet, "/api/v1/savings/targets", nil, alice); w.Code != http.StatusServiceUnavailable {
		t.Errorf("no service: %d", w.Code)
	}
}
