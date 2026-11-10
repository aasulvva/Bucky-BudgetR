package httpapi_test

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cycles"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

func TestTransactionsAPI(t *testing.T) {
	pool := testdb.New(t)
	l := ledger.New(ledger.Options{})
	h := newHandler(t, discard(), pool, httpapi.Options{
		Auth:         auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge}),
		Accounts:     accounts.NewService(pool, l, accounts.Options{}),
		Cycles:       cycles.NewService(pool, cycles.Options{}),
		Buckets:      buckets.NewService(pool, l, buckets.Options{}),
		Transactions: transactions.NewService(pool, l, transactions.Options{}),
	})
	authtest.NewUser(t, pool, "alice")
	authtest.NewUser(t, pool, "bob")
	alice, bob := authtest.Login(t, h, "alice"), authtest.Login(t, h, "bob")
	do := func(method, path string, body any, c *http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		return authtest.Do(t, h, method, path, body, c)
	}

	w := do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": "Main", "opening_balance": "10000"}, alice)
	expect(t, "create account", w, http.StatusCreated, "")
	main := decode[api.Account](t, w).Id
	w = do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": "Savings"}, alice)
	expect(t, "create savings", w, http.StatusCreated, "")
	savings := decode[api.Account](t, w).Id
	w = do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": "Euro", "currency": "EUR"}, alice)
	expect(t, "create EUR account", w, http.StatusCreated, "")
	eur := decode[api.Account](t, w).Id
	w = do(http.MethodPost, "/api/v1/buckets", map[string]any{"name": "Groceries", "source_account_id": main}, alice)
	expect(t, "create bucket", w, http.StatusCreated, "")
	groceries := decode[api.Bucket](t, w).Id

	expense := map[string]any{
		"type": "EXP", "account_id": main, "amount": "500", "counterparty": "Rema 1000", "tags": []string{"food"},
		"bucket_lines": []map[string]any{{"bucket_id": groceries, "amount": "400"}},
	}
	expect(t, "no session", do(http.MethodPost, "/api/v1/transactions", expense, nil), http.StatusUnauthorized, "unauthenticated")
	expect(t, "no cycle", do(http.MethodPost, "/api/v1/transactions", expense, alice), http.StatusConflict, "no_active_cycle")

	now := time.Now().UTC()
	w = do(http.MethodPost, "/api/v1/cycles", map[string]any{"start_at": now.Add(time.Hour), "end_at": now.Add(30 * 24 * time.Hour)}, alice)
	expect(t, "create cycle", w, http.StatusCreated, "")
	expect(t, "start cycle", do(http.MethodPost, "/api/v1/cycles/"+decode[api.Cycle](t, w).Id+"/start", nil, alice), http.StatusOK, "")

	w = do(http.MethodPost, "/api/v1/transactions", expense, alice)
	expect(t, "create EXP", w, http.StatusCreated, "")
	exp := decode[api.Transaction](t, w)
	if exp.Type != api.TransactionTypeEXP || len(exp.BankLines) != 1 || exp.BankLines[0].Amount != "-500.00" ||
		len(exp.BucketLines) != 1 || exp.BucketLines[0].Amount != "-400.00" || exp.CreatedBy.MustGet() == "" || exp.History != nil {
		t.Errorf("EXP %+v", exp)
	}

	w = do(http.MethodPost, "/api/v1/transactions", map[string]any{"type": "TRF", "account_id": main, "to_account_id": savings, "amount": "1000"}, alice)
	expect(t, "create TRF", w, http.StatusCreated, "")

	for name, body := range map[string]map[string]any{
		"over the amount": {"type": "EXP", "account_id": main, "amount": "5", "bucket_lines": []map[string]any{{"bucket_id": groceries, "amount": "6"}}},
		"future":          {"type": "EXP", "account_id": main, "amount": "5", "at": now.Add(time.Hour)},
		"system type":     {"type": "REF", "account_id": main, "amount": "5"},
		"long tag":        {"type": "EXP", "account_id": main, "amount": "5", "tags": []string{string(make([]byte, 51))}},
		"bucket twice": {"type": "EXP", "account_id": main, "amount": "5", "bucket_lines": []map[string]any{
			{"bucket_id": groceries, "amount": "1"}, {"bucket_id": groceries, "amount": "1"}}},
	} {
		expect(t, name, do(http.MethodPost, "/api/v1/transactions", body, alice), http.StatusBadRequest, "invalid_request")
	}
	expect(t, "TRF to EUR", do(http.MethodPost, "/api/v1/transactions",
		map[string]any{"type": "TRF", "account_id": main, "to_account_id": eur, "amount": "5"}, alice), http.StatusBadRequest, "currency_mismatch")

	w = do(http.MethodGet, "/api/v1/transactions/"+exp.Id, nil, alice)
	expect(t, "get", w, http.StatusOK, "")
	if got := decode[api.Transaction](t, w); got.History == nil || len(*got.History) != 1 {
		t.Errorf("get %+v, want a history of 1", got)
	}
	expect(t, "bob gets alice's", do(http.MethodGet, "/api/v1/transactions/"+exp.Id, nil, bob), http.StatusNotFound, "not_found")
	expect(t, "bad ID", do(http.MethodGet, "/api/v1/transactions/123", nil, alice), http.StatusBadRequest, "invalid_request")

	// The list: 3 transactions (OPB, EXP, TRF), 2 per page.
	w = do(http.MethodGet, "/api/v1/transactions?limit=2", nil, alice)
	expect(t, "list", w, http.StatusOK, "")
	page := decode[api.TransactionPage](t, w)
	next, err := page.NextCursor.Get()
	if len(page.Items) != 2 || err != nil {
		t.Fatalf("first page %+v", page)
	}
	w = do(http.MethodGet, "/api/v1/transactions?limit=2&cursor="+url.QueryEscape(next), nil, alice)
	expect(t, "next page", w, http.StatusOK, "")
	if page := decode[api.TransactionPage](t, w); len(page.Items) != 1 || !page.NextCursor.IsNull() || page.Items[0].Type != api.TransactionTypeOPB {
		t.Errorf("last page %+v", page)
	}

	w = do(http.MethodGet, "/api/v1/transactions?type=EXP&type=TRF&tag=FOOD", nil, alice)
	expect(t, "filtered", w, http.StatusOK, "")
	if page := decode[api.TransactionPage](t, w); len(page.Items) != 1 || page.Items[0].Id != exp.Id {
		t.Errorf("filtered %+v", page)
	}
	// Oldest first (#126).
	w = do(http.MethodGet, "/api/v1/transactions?order=oldest", nil, alice)
	expect(t, "oldest first", w, http.StatusOK, "")
	if page := decode[api.TransactionPage](t, w); len(page.Items) < 2 || page.Items[0].At.After(page.Items[len(page.Items)-1].At) {
		t.Errorf("oldest first %+v", page)
	}
	expect(t, "bad order", do(http.MethodGet, "/api/v1/transactions?order=sideways", nil, alice), http.StatusBadRequest, "invalid_request")
	// Several tags match any of them (#126).
	w = do(http.MethodGet, "/api/v1/transactions?type=EXP&type=TRF&tag=nope&tag=FOOD", nil, alice)
	expect(t, "several tags", w, http.StatusOK, "")
	if page := decode[api.TransactionPage](t, w); len(page.Items) != 1 || page.Items[0].Id != exp.Id {
		t.Errorf("several tags %+v", page)
	}
	expect(t, "bad type", do(http.MethodGet, "/api/v1/transactions?type=XYZ", nil, alice), http.StatusBadRequest, "invalid_request")
	expect(t, "bad cursor", do(http.MethodGet, "/api/v1/transactions?cursor=abc", nil, alice), http.StatusBadRequest, "invalid_request")

	w = do(http.MethodGet, "/api/v1/transactions", nil, bob)
	if page := decode[api.TransactionPage](t, w); len(page.Items) != 0 {
		t.Errorf("bob sees %d transactions", len(page.Items))
	}

	// Suggestions for the Create transaction screen; the service tests cover
	// the rules.
	expect(t, "counterparties without a session", do(http.MethodGet, "/api/v1/counterparties", nil, nil), http.StatusUnauthorized, "unauthenticated")
	expect(t, "tags without a session", do(http.MethodGet, "/api/v1/tags", nil, nil), http.StatusUnauthorized, "unauthenticated")
	w = do(http.MethodGet, "/api/v1/counterparties?type=EXP&q=rema", nil, alice)
	expect(t, "counterparties", w, http.StatusOK, "")
	if cps := decode[[]api.CounterpartySuggestion](t, w); len(cps) != 1 || cps[0].Counterparty != "Rema 1000" ||
		cps[0].Type != api.CounterpartySuggestionTypeEXP || cps[0].AccountId != main ||
		len(cps[0].Tags) != 1 || cps[0].Tags[0] != "food" || len(cps[0].BucketIds) != 1 || cps[0].BucketIds[0] != groceries {
		t.Errorf("counterparties %+v", cps)
	}
	expect(t, "counterparties of transfers", do(http.MethodGet, "/api/v1/counterparties?type=TRF", nil, alice), http.StatusBadRequest, "invalid_request")
	expect(t, "counterparties limit", do(http.MethodGet, "/api/v1/counterparties?limit=51", nil, alice), http.StatusBadRequest, "invalid_request")
	w = do(http.MethodGet, "/api/v1/tags", nil, alice)
	expect(t, "tags", w, http.StatusOK, "")
	if tags := decode[[]api.Tag](t, w); len(tags) != 1 || tags[0].Name != "food" || !tags[0].LastUsedAt.IsSpecified() || tags[0].LastUsedAt.IsNull() {
		t.Errorf("tags %+v", tags)
	}
	expect(t, "tags limit", do(http.MethodGet, "/api/v1/tags?limit=0", nil, alice), http.StatusBadRequest, "invalid_request")
	w = do(http.MethodGet, "/api/v1/tags", nil, bob)
	if tags := decode[[]api.Tag](t, w); len(tags) != 0 {
		t.Errorf("bob sees tags %+v", tags)
	}
}
