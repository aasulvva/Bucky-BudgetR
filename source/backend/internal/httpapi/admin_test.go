package httpapi_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
)

func decodeJSON[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.NewDecoder(w.Body).Decode(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestAdminOnly(t *testing.T) {
	e := setup(t)
	alice := authtest.NewUser(t, e.pool, "alice")
	authtest.NewUser(t, e.pool, "fresh", authtest.Admin, authtest.MustChangePassword)
	c := authtest.Login(t, e.h, "alice")

	for _, r := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/admin/users"},
		{http.MethodPost, "/api/v1/admin/users"},
		{http.MethodPatch, "/api/v1/admin/users/" + alice.ID},
		{http.MethodPost, "/api/v1/admin/users/" + alice.ID + "/reset-password"},
	} {
		var body any
		switch r.method {
		case http.MethodPost:
			body = map[string]any{"username": "mallory"}
		case http.MethodPatch:
			body = map[string]any{"admin": true}
		}
		w := authtest.Do(t, e.h, r.method, r.path, body, c)
		if w.Code != http.StatusForbidden || deref(decodeProblem(t, w).Code) != "admin_only" {
			t.Errorf("%s %s as a user: %d %s", r.method, r.path, w.Code, w.Body)
		}
	}

	// An admin who must change their password does that first.
	fresh := authtest.Login(t, e.h, "fresh")
	w := authtest.Do(t, e.h, http.MethodGet, "/api/v1/admin/users", nil, fresh)
	if w.Code != http.StatusForbidden || deref(decodeProblem(t, w).Code) != "password_change_required" {
		t.Errorf("admin before changing the password: %d %s", w.Code, w.Body)
	}
}

func TestUserManagement(t *testing.T) {
	e := setup(t)
	admin := authtest.NewUser(t, e.pool, "admin", authtest.Admin)
	c := authtest.Login(t, e.h, "admin")
	do := func(method, path string, body any) *httptest.ResponseRecorder {
		return authtest.Do(t, e.h, method, "/api/v1/admin/users"+path, body, c)
	}
	code := func(w *httptest.ResponseRecorder) string { return deref(decodeProblem(t, w).Code) }

	w := do(http.MethodPost, "", map[string]any{"username": "kari"})
	if w.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", w.Code, w.Body)
	}
	created := decodeJSON[api.CreatedUser](t, w)
	kari := created.User
	if kari.Username != "kari" || !kari.Active || kari.Admin || !kari.MustChangePassword {
		t.Errorf("created %+v", kari)
	}
	if by, err := kari.CreatedBy.Get(); err != nil || by != admin.ID {
		t.Errorf("created_by %q, %v", by, err)
	}
	w = login(t, e, "kari", created.TemporaryPassword)
	if w.Code != http.StatusOK {
		t.Fatalf("login with the temporary password: %d %s", w.Code, w.Body)
	}
	kariCookie := w.Result().Cookies()[0]

	for _, tc := range []struct {
		body any
		want int
		code string
	}{
		{map[string]any{"username": "KARI"}, http.StatusConflict, "username_taken"},
		{map[string]any{"username": "no spaces"}, http.StatusBadRequest, "invalid_request"},
		{map[string]any{"username": "ab"}, http.StatusBadRequest, "invalid_request"},
	} {
		if w := do(http.MethodPost, "", tc.body); w.Code != tc.want || code(w) != tc.code {
			t.Errorf("create %v: %d %s", tc.body, w.Code, w.Body)
		}
	}

	w = do(http.MethodGet, "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list: %d", w.Code)
	}
	users := decodeJSON[[]api.AdminUser](t, w)
	if len(users) != 2 || users[0].Username != "admin" || users[1].Username != "kari" {
		t.Fatalf("users %+v", users)
	}
	if _, err := users[0].LastSeenAt.Get(); err != nil {
		t.Errorf("admin is logged in, so has a last seen time: %v", err)
	}
	if !users[0].CreatedBy.IsNull() {
		t.Errorf("admin wasn't created by anyone: %+v", users[0].CreatedBy)
	}

	w = do(http.MethodPatch, "/"+kari.Id, map[string]any{"active": false})
	if w.Code != http.StatusOK || decodeJSON[api.AdminUser](t, w).Active {
		t.Fatalf("deactivate: %d %s", w.Code, w.Body)
	}
	if w := me(t, e, kariCookie); w.Code != http.StatusUnauthorized {
		t.Errorf("kari's session must end: %d", w.Code)
	}
	w = do(http.MethodPatch, "/"+kari.Id, map[string]any{"active": true, "admin": true})
	if u := decodeJSON[api.AdminUser](t, w); w.Code != http.StatusOK || !u.Active || !u.Admin {
		t.Errorf("activate and promote: %d %+v", w.Code, u)
	}

	w = do(http.MethodPost, "/"+kari.Id+"/reset-password", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("reset: %d %s", w.Code, w.Body)
	}
	if w := login(t, e, "kari", decodeJSON[api.TemporaryPassword](t, w).TemporaryPassword); w.Code != http.StatusOK {
		t.Errorf("login with the reset password: %d", w.Code)
	}

	for _, tc := range []struct {
		method, path string
		body         any
		want         int
		code         string
	}{
		{http.MethodPatch, "/" + admin.ID, map[string]any{"admin": false}, http.StatusConflict, "own_account"},
		{http.MethodPost, "/" + admin.ID + "/reset-password", nil, http.StatusConflict, "own_account"},
		{http.MethodPatch, "/" + kari.Id, map[string]any{}, http.StatusBadRequest, "invalid_request"},
		{http.MethodPatch, "/999999", map[string]any{"active": true}, http.StatusNotFound, "not_found"},
		{http.MethodPost, "/999999/reset-password", nil, http.StatusNotFound, "not_found"},
		{http.MethodPatch, "/12", map[string]any{"active": true}, http.StatusBadRequest, "invalid_request"},
	} {
		if w := do(tc.method, tc.path, tc.body); w.Code != tc.want || code(w) != tc.code {
			t.Errorf("%s %s: %d %s", tc.method, tc.path, w.Code, w.Body)
		}
	}
}
