package httpapi_test

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/allocation"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/userdata"
)

// upload posts raw bytes as the import does.
func upload(t *testing.T, h http.Handler, path string, body []byte, c *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequestWithContext(context.Background(), http.MethodPost, path, bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/octet-stream")
	r.Header.Set("X-Bucky-CSRF", "1")
	r.AddCookie(c)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

// The data export and import (#36).
func TestUserDataAPI(t *testing.T) {
	pool := testdb.New(t)
	l := ledger.New(ledger.Options{AfterRecord: allocation.AfterRecord})
	accts := accounts.NewService(pool, l, accounts.Options{})
	h := newHandler(t, discard(), pool, httpapi.Options{
		Auth:     auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge}),
		Accounts: accts,
		UserData: userdata.NewService(pool, userdata.Options{}),
	})
	alice := authtest.NewUser(t, pool, "alice")
	c := authtest.Login(t, h, "alice")
	if _, err := accts.Create(t.Context(), alice.ID, accounts.New{Name: "Main", OpeningBalance: decimal.RequireFromString("1234567890.10")}); err != nil {
		t.Fatal(err)
	}

	w := authtest.Do(t, h, http.MethodGet, "/api/v1/me/export", nil, c)
	if w.Code != http.StatusOK {
		t.Fatalf("export: %d %s", w.Code, w.Body)
	}
	file := w.Body.Bytes()
	if !strings.Contains(string(file), `"amount":1234567890.10`) || !strings.Contains(string(file), `"username":"alice"`) {
		t.Errorf("export file: %s", file)
	}

	// Another account, then the import puts things back as they were.
	if _, err := accts.Create(t.Context(), alice.ID, accounts.New{Name: "Later"}); err != nil {
		t.Fatal(err)
	}
	w = upload(t, h, "/api/v1/me/import", file, c)
	if w.Code != http.StatusOK {
		t.Fatalf("import: %d %s", w.Code, w.Body)
	}
	if got := decodeJSON[api.ImportResult](t, w); got != (api.ImportResult{Accounts: 1, Transactions: 1}) {
		t.Errorf("import result %+v", got)
	}
	w = authtest.Do(t, h, http.MethodGet, "/api/v1/accounts", nil, c)
	if list := decodeJSON[[]api.Account](t, w); len(list) != 1 || list[0].Name != "Main" || list[0].Balance != "1234567890.10" {
		t.Errorf("accounts after the import: %+v", list)
	}

	newer := bytes.Replace(file, []byte(`"format":1`), []byte(`"format":2`), 1)
	for _, tc := range []struct {
		body []byte
		want int
		code string
	}{
		{[]byte(`{"app":"other"}`), http.StatusBadRequest, "invalid_export"},
		{[]byte(`not json`), http.StatusBadRequest, "invalid_export"},
		{newer, http.StatusConflict, "export_too_new"},
		{bytes.Repeat([]byte(" "), 65<<20), http.StatusRequestEntityTooLarge, "body_too_large"},
	} {
		w := upload(t, h, "/api/v1/me/import", tc.body, c)
		if w.Code != tc.want || deref(decodeProblem(t, w).Code) != tc.code {
			t.Errorf("import %.20q: %d %s", tc.body, w.Code, w.Body)
		}
	}

	// Only the import may send more than 1 MiB.
	big := map[string]string{"name": strings.Repeat("x", 2<<20)}
	if w := authtest.Do(t, h, http.MethodPost, "/api/v1/accounts", big, c); w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("a large body elsewhere: %d", w.Code)
	}
	// A large import within its limit gets through to the file check.
	padded := append(bytes.Repeat([]byte(" "), 2<<20), file...)
	start := time.Now()
	if w := upload(t, h, "/api/v1/me/import", padded, c); w.Code != http.StatusOK {
		t.Errorf("a 2 MiB import: %d %s", w.Code, w.Body)
	}
	if time.Since(start) > 10*time.Second {
		t.Error("the import is slow")
	}
}
