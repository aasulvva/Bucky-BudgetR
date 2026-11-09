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
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledgertest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

// Deleting an account can delete its buckets with it (#137).
func TestDeleteAccountBucketsAPI(t *testing.T) {
	pool := testdb.New(t)
	authSvc := auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge})
	h := newHandler(t, discard(), pool, httpapi.Options{
		Auth:     authSvc,
		Accounts: accounts.NewService(pool, ledger.New(ledger.Options{}), accounts.Options{}),
	})
	user := authtest.NewUser(t, pool, "alice").ID
	alice := authtest.Login(t, h, "alice")
	do := func(method, path string, body any) *httptest.ResponseRecorder {
		t.Helper()
		return authtest.Do(t, h, method, path, body, alice)
	}
	create := func(name string) api.Account {
		t.Helper()
		w := do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": name, "type": "usage"})
		expect(t, "create "+name, w, http.StatusCreated, "")
		return decode[api.Account](t, w)
	}
	old, other := create("Old"), create("Other")
	gone := ledgertest.Bucket(t, pool, user, old.Id)
	moved := ledgertest.Bucket(t, pool, user, old.Id)
	path := "/api/v1/accounts/" + old.Id + "/delete"

	expect(t, "one left out", do(http.MethodPost, path, map[string]any{"delete_buckets": []string{gone}}),
		http.StatusConflict, "account_has_buckets")
	expect(t, "both", do(http.MethodPost, path, map[string]any{
		"delete_buckets": []string{gone, moved},
		"bucket_sources": map[string]string{moved: other.Id},
	}), http.StatusBadRequest, "invalid_request")
	expect(t, "delete and move", do(http.MethodPost, path, map[string]any{
		"delete_buckets": []string{gone},
		"bucket_sources": map[string]string{moved: other.Id},
	}), http.StatusNoContent, "")

	var deleted bool
	var source string
	if err := pool.QueryRow(t.Context(), "SELECT deleted FROM buckets WHERE id = $1", gone).Scan(&deleted); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(t.Context(), "SELECT source_account_id FROM buckets WHERE id = $1", moved).Scan(&source); err != nil {
		t.Fatal(err)
	}
	if !deleted || source != other.Id {
		t.Errorf("deleted %v, moved to %s; want deleted, moved to %s", deleted, source, other.Id)
	}
}
