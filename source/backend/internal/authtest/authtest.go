// Package authtest helps tests create users and make authenticated requests.
// Use it in every feature's "user A can't see user B's data" tests.
package authtest

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
)

// Password is the password of every user NewUser creates.
const Password = "test password 123"

// UserOption adjusts a user created by NewUser.
type UserOption func(*sqlc.CreateUserParams)

// Admin makes the user an admin.
func Admin(p *sqlc.CreateUserParams) { p.Admin = true }

// MustChangePassword sets must_change_password.
func MustChangePassword(p *sqlc.CreateUserParams) { p.MustChangePassword = true }

// NewUser creates a user with Password. The hash uses bcrypt's minimum cost
// so tests stay fast.
func NewUser(t testing.TB, pool *pgxpool.Pool, username string, opts ...UserOption) sqlc.User {
	t.Helper()
	ctx := context.Background()
	hash, err := bcrypt.GenerateFromPassword([]byte(Password), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	q := sqlc.New(pool)
	params := sqlc.CreateUserParams{Username: username, PasswordHash: string(hash)}
	for _, o := range opts {
		o(&params)
	}
	id, err := ids.Insert(ctx, ids.User, ids.NewUser, func(ctx context.Context, id string) (bool, error) {
		params.ID = id
		_, err := q.CreateUser(ctx, params)
		return ids.Inserted(err)
	})
	if err != nil {
		t.Fatal(err)
	}
	user, err := q.GetUser(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	return user
}

// Deactivate marks the user inactive.
func Deactivate(t testing.TB, pool *pgxpool.Pool, userID string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), "UPDATE users SET active = false WHERE id = $1", userID); err != nil {
		t.Fatal(err)
	}
}

// Do sends a request to h. body, if not nil, is sent as JSON. State-changing
// methods get the CSRF header, as the frontend sends it.
func Do(t testing.TB, h http.Handler, method, path string, body any, cookie *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequestWithContext(context.Background(), method, path, &buf)
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if method != http.MethodGet && method != http.MethodHead {
		r.Header.Set("X-Bucky-CSRF", "1")
	}
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

// Login logs in as username with Password and returns the session cookie.
func Login(t testing.TB, h http.Handler, username string) *http.Cookie {
	t.Helper()
	w := Do(t, h, http.MethodPost, "/api/v1/auth/login", map[string]string{"username": username, "password": Password}, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("login as %s: %d %s", username, w.Code, w.Body)
	}
	for _, c := range w.Result().Cookies() {
		if c.Name == "__Host-bucky_session" {
			return c
		}
	}
	t.Fatal("login set no session cookie")
	return nil
}
