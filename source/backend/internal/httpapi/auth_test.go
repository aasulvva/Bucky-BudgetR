package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

type env struct {
	h     http.Handler
	pool  *pgxpool.Pool
	clock *clock
}

const (
	idle   = time.Hour
	maxAge = 24 * time.Hour
)

func setup(t *testing.T) env {
	t.Helper()
	pool := testdb.New(t)
	c := &clock{now: time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)}
	svc := auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge, Now: c.Now})
	return env{h: newHandler(t, discard(), pool, httpapi.Options{Auth: svc}), pool: pool, clock: c}
}

func login(t *testing.T, e env, username, password string) *httptest.ResponseRecorder {
	t.Helper()
	return authtest.Do(t, e.h, http.MethodPost, "/api/v1/auth/login",
		map[string]string{"username": username, "password": password}, nil)
}

func me(t *testing.T, e env, c *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	return authtest.Do(t, e.h, http.MethodGet, "/api/v1/me", nil, c)
}

func decodeUser(t *testing.T, w *httptest.ResponseRecorder) api.User {
	t.Helper()
	var u api.User
	if err := json.NewDecoder(w.Body).Decode(&u); err != nil {
		t.Fatal(err)
	}
	return u
}

func TestLoginSetsSecureCookie(t *testing.T) {
	e := setup(t)
	user := authtest.NewUser(t, e.pool, "Alice")

	// Usernames are case-insensitive.
	w := login(t, e, "alice", authtest.Password)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	if got := decodeUser(t, w); got.Id != user.ID || got.Username != "Alice" || got.MustChangePassword {
		t.Errorf("unexpected user %+v", got)
	}

	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookies: %v", cookies)
	}
	c := cookies[0]
	if c.Name != httpapi.SessionCookie || len(c.Value) < 40 || c.Path != "/" || !c.HttpOnly || !c.Secure ||
		c.SameSite != http.SameSiteLaxMode || c.MaxAge != int(maxAge.Seconds()) || c.Domain != "" {
		t.Errorf("cookie attributes: %#v", c)
	}

	if w := me(t, e, c); w.Code != http.StatusOK || decodeUser(t, w).Id != user.ID {
		t.Errorf("/me with the new session: %d %s", w.Code, w.Body)
	}
}

func TestLoginFailuresLookAlike(t *testing.T) {
	e := setup(t)
	authtest.NewUser(t, e.pool, "alice")
	inactive := authtest.NewUser(t, e.pool, "bob")
	authtest.Deactivate(t, e.pool, inactive.ID)

	var bodies []string
	for _, tc := range []struct{ user, password string }{
		{"alice", "wrong password!"},
		{"nobody", authtest.Password},
		{"bob", authtest.Password},
	} {
		w := login(t, e, tc.user, tc.password)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("%s: got %d", tc.user, w.Code)
		}
		p := decodeProblem(t, w)
		bodies = append(bodies, deref(p.Code)+"|"+deref(p.Detail))
		if len(w.Result().Cookies()) != 0 {
			t.Errorf("%s: failed login set a cookie", tc.user)
		}
	}
	if bodies[0] != bodies[1] || bodies[1] != bodies[2] {
		t.Errorf("failures should be indistinguishable: %q", bodies)
	}
}

func TestLoginRateLimit(t *testing.T) {
	e := setup(t)
	authtest.NewUser(t, e.pool, "alice")

	for range 5 {
		login(t, e, "alice", "wrong password!")
	}
	// Locked: even the right password is refused for now.
	w := login(t, e, "alice", authtest.Password)
	if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") != "60" {
		t.Fatalf("got %d, Retry-After %q", w.Code, w.Header().Get("Retry-After"))
	}
	if p := decodeProblem(t, w); deref(p.Code) != "too_many_attempts" {
		t.Errorf("unexpected problem %+v", p)
	}

	e.clock.Advance(time.Minute)
	if w := login(t, e, "alice", authtest.Password); w.Code != http.StatusOK {
		t.Errorf("after the lockout: %d", w.Code)
	}
}

func TestUnauthenticated(t *testing.T) {
	e := setup(t)
	for _, path := range []string{"/api/v1/me"} {
		w := authtest.Do(t, e.h, http.MethodGet, path, nil, nil)
		if w.Code != http.StatusUnauthorized || deref(decodeProblem(t, w).Code) != "unauthenticated" {
			t.Errorf("%s: got %d", path, w.Code)
		}
	}
	w := authtest.Do(t, e.h, http.MethodGet, "/api/v1/me", nil,
		&http.Cookie{Name: httpapi.SessionCookie, Value: "forged"})
	if w.Code != http.StatusUnauthorized {
		t.Errorf("forged cookie: got %d", w.Code)
	}
	if c := w.Result().Cookies(); len(c) != 1 || c[0].MaxAge != -1 {
		t.Errorf("a stale cookie should be cleared: %v", c)
	}
}

func TestSessionExpiry(t *testing.T) {
	e := setup(t)
	authtest.NewUser(t, e.pool, "alice")

	t.Run("idle", func(t *testing.T) {
		c := authtest.Login(t, e.h, "alice")
		e.clock.Advance(idle - time.Minute)
		if w := me(t, e, c); w.Code != http.StatusOK {
			t.Fatalf("before the idle timeout: %d", w.Code)
		}
		// Using the session reset the idle timer.
		e.clock.Advance(idle - time.Minute)
		if w := me(t, e, c); w.Code != http.StatusOK {
			t.Fatalf("used within the idle timeout: %d", w.Code)
		}
		e.clock.Advance(idle)
		if w := me(t, e, c); w.Code != http.StatusUnauthorized {
			t.Errorf("after the idle timeout: %d", w.Code)
		}
	})

	t.Run("absolute", func(t *testing.T) {
		c := authtest.Login(t, e.h, "alice")
		for elapsed := time.Duration(0); elapsed < maxAge-idle; elapsed += idle / 2 {
			e.clock.Advance(idle / 2)
			if w := me(t, e, c); w.Code != http.StatusOK {
				t.Fatalf("after %v: %d", elapsed, w.Code)
			}
		}
		e.clock.Advance(idle)
		if w := me(t, e, c); w.Code != http.StatusUnauthorized {
			t.Errorf("after the maximum age: %d", w.Code)
		}
	})
}

func TestLogout(t *testing.T) {
	e := setup(t)
	authtest.NewUser(t, e.pool, "alice")
	c := authtest.Login(t, e.h, "alice")

	w := authtest.Do(t, e.h, http.MethodPost, "/api/v1/auth/logout", nil, c)
	if w.Code != http.StatusNoContent {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	if cs := w.Result().Cookies(); len(cs) != 1 || cs[0].MaxAge != -1 {
		t.Errorf("logout should clear the cookie: %v", cs)
	}
	if w := me(t, e, c); w.Code != http.StatusUnauthorized {
		t.Errorf("session still valid after logout: %d", w.Code)
	}
}

func TestInactiveUserLosesSessions(t *testing.T) {
	e := setup(t)
	alice := authtest.NewUser(t, e.pool, "alice")
	c := authtest.Login(t, e.h, "alice")

	authtest.Deactivate(t, e.pool, alice.ID)
	if w := me(t, e, c); w.Code != http.StatusUnauthorized {
		t.Fatalf("inactive user's session still works: %d", w.Code)
	}
	var n int
	if err := e.pool.QueryRow(context.Background(), "SELECT count(*) FROM sessions WHERE user_id = $1", alice.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("%d sessions left for an inactive user", n)
	}
}

func TestChangePassword(t *testing.T) {
	e := setup(t)
	authtest.NewUser(t, e.pool, "alice", authtest.MustChangePassword)
	current := authtest.Login(t, e.h, "alice")
	other := authtest.Login(t, e.h, "alice")

	change := func(cur, next string) *httptest.ResponseRecorder {
		return authtest.Do(t, e.h, http.MethodPost, "/api/v1/me/password",
			map[string]string{"current_password": cur, "new_password": next}, current)
	}

	w := change("wrong password!", "a brand new password")
	if w.Code != http.StatusBadRequest || deref(decodeProblem(t, w).Code) != "wrong_password" {
		t.Fatalf("wrong current password: %d", w.Code)
	}
	w = change(authtest.Password, authtest.Password)
	if w.Code != http.StatusBadRequest || deref(decodeProblem(t, w).Code) != "weak_password" {
		t.Fatalf("same password: %d", w.Code)
	}
	w = change(authtest.Password, "short")
	if w.Code != http.StatusBadRequest || deref(decodeProblem(t, w).Code) != "invalid_request" {
		t.Fatalf("too short (spec minLength): %d", w.Code)
	}

	if w := change(authtest.Password, "a brand new password"); w.Code != http.StatusNoContent {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	w = me(t, e, current)
	if w.Code != http.StatusOK || decodeUser(t, w).MustChangePassword {
		t.Errorf("this session should stay, with the flag cleared: %d", w.Code)
	}
	if w := me(t, e, other); w.Code != http.StatusUnauthorized {
		t.Errorf("other sessions should end: %d", w.Code)
	}
	if w := login(t, e, "alice", "a brand new password"); w.Code != http.StatusOK {
		t.Errorf("login with the new password: %d", w.Code)
	}
}

func TestMustChangePasswordGate(t *testing.T) {
	e := setup(t)
	authtest.NewUser(t, e.pool, "admin", authtest.Admin, authtest.MustChangePassword)
	c := authtest.Login(t, e.h, "admin")

	w := authtest.Do(t, e.h, http.MethodPatch, "/api/v1/me/preferences", map[string]any{"locale": "nb-NO"}, c)
	if w.Code != http.StatusForbidden || deref(decodeProblem(t, w).Code) != "password_change_required" {
		t.Errorf("preferences before changing the password: %d", w.Code)
	}
	if w := me(t, e, c); w.Code != http.StatusOK || !decodeUser(t, w).MustChangePassword {
		t.Errorf("/me must stay reachable: %d", w.Code)
	}
	if w := authtest.Do(t, e.h, http.MethodPost, "/api/v1/auth/logout", nil, c); w.Code != http.StatusNoContent {
		t.Errorf("logout must stay reachable: %d", w.Code)
	}
}

func TestCSRF(t *testing.T) {
	e := setup(t)
	authtest.NewUser(t, e.pool, "alice")
	c := authtest.Login(t, e.h, "alice")

	send := func(header, origin string) int {
		r := httptest.NewRequestWithContext(t.Context(), http.MethodPatch, "/api/v1/me/preferences",
			strings.NewReader(`{"locale":"nb-NO"}`))
		r.Header.Set("Content-Type", "application/json")
		if header != "" {
			r.Header.Set(httpapi.CSRFHeader, header)
		}
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		r.AddCookie(c)
		w := httptest.NewRecorder()
		e.h.ServeHTTP(w, r)
		return w.Code
	}

	if got := send("", ""); got != http.StatusForbidden {
		t.Errorf("without the header: %d", got)
	}
	if got := send("1", "https://evil.example"); got != http.StatusForbidden {
		t.Errorf("from a foreign origin: %d", got)
	}
	if got := send("1", "http://example.com"); got != http.StatusOK {
		t.Errorf("same origin with the header: %d", got)
	}
	// Login is protected too: it is a POST under /api/.
	r := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/api/v1/auth/login",
		strings.NewReader(`{"username":"alice","password":"x"}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Errorf("login without the header: %d", w.Code)
	}
}

func TestPreferences(t *testing.T) {
	e := setup(t)
	authtest.NewUser(t, e.pool, "alice")
	c := authtest.Login(t, e.h, "alice")

	patch := func(body string) *httptest.ResponseRecorder {
		r := httptest.NewRequestWithContext(t.Context(), http.MethodPatch, "/api/v1/me/preferences", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set(httpapi.CSRFHeader, "1")
		r.AddCookie(c)
		w := httptest.NewRecorder()
		e.h.ServeHTTP(w, r)
		return w
	}

	if w := patch(`{"locale":"nb-NO"}`); w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != `{"locale":"nb-NO"}` {
		t.Fatalf("set: %d %s", w.Code, w.Body)
	}
	// An empty patch changes nothing.
	if w := patch(`{}`); strings.TrimSpace(w.Body.String()) != `{"locale":"nb-NO"}` {
		t.Errorf("empty patch: %s", w.Body)
	}
	if locale, err := decodeUser(t, me(t, e, c)).Preferences.Locale.Get(); err != nil || locale != "nb-NO" {
		t.Errorf("/me doesn't show the preference: %q, %v", locale, err)
	}
	// null resets to the default.
	if w := patch(`{"locale":null}`); w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != `{}` {
		t.Errorf("reset: %d %s", w.Code, w.Body)
	}

	// The language is separate from the locale.
	if w := patch(`{"language":"nn"}`); w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != `{"language":"nn"}` {
		t.Errorf("language: %d %s", w.Code, w.Body)
	}
	if w := patch(`{"language":null}`); w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != `{}` {
		t.Errorf("language reset: %d %s", w.Code, w.Body)
	}

	// The Dashboard's settings are replaced as a whole.
	dashboard := `{"dashboard":{"accounts":{"account_id":"1234","mode":"account"},"bucket_status":{"bucket_id":"1000000001","mode":"bucket"},"cycle":{"show_next":false},"recent_transactions":{"count":10}}}`
	if w := patch(dashboard); w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != dashboard {
		t.Errorf("dashboard: %d %s", w.Code, w.Body)
	}
	want := `{"dashboard":{"bucket_status":{"mode":"all"}}}`
	if w := patch(`{"dashboard":{"bucket_status":{"mode":"all","bucket_id":null}}}`); strings.TrimSpace(w.Body.String()) != want {
		t.Errorf("dashboard replaced: %d %s", w.Code, w.Body)
	}
	// The layout (#37): a list of widgets, each with its own settings.
	layout := `{"dashboard":{"widgets":[{"cycle":{"show_next":false},"id":"a1","type":"cycle","width":"full"},{"bucket_status":{"bucket_id":"1000000001","mode":"bucket"},"id":"b-2","type":"bucket_status","width":"half"},{"bucket_status":{"mode":"most_used","show_mode":false},"id":"b_3","type":"bucket_status","width":"half"},{"id":"h","title":"Health","type":"health","width":"half"}]}}`
	if w := patch(layout); w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != layout {
		t.Errorf("layout: %d %s", w.Code, w.Body)
	}
	if w := patch(`{"dashboard":{"widgets":[]}}`); strings.TrimSpace(w.Body.String()) != `{"dashboard":{"widgets":[]}}` {
		t.Errorf("empty layout: %d %s", w.Code, w.Body)
	}
	if w := patch(`{"dashboard":null}`); strings.TrimSpace(w.Body.String()) != `{}` {
		t.Errorf("dashboard reset: %d %s", w.Code, w.Body)
	}

	for _, body := range []string{
		`{"theme":"dark"}`, `{"locale":"not a locale!"}`, `{"locale":42}`, `{"language":"de"}`, `[]`,
		`{"dashboard":{"bucket_status":{"mode":"some"}}}`,
		`{"dashboard":{"bucket_status":{"mode":"bucket","bucket_id":"42"}}}`,
		`{"dashboard":{"recent_transactions":{"count":0}}}`,
		`{"dashboard":{"recent_transactions":{"count":21}}}`,
		`{"dashboard":{"graphs":{}}}`,
		`{"dashboard":{"cycle":{}}}`,
		`{"dashboard":{"accounts":{"mode":"account","account_id":"12"}}}`,
		`{"dashboard":{"widgets":[{"id":"a","type":"health","width":"half"},{"id":"a","type":"cycle","width":"half"}]}}`,
		`{"dashboard":{"widgets":[{"id":"a","type":"cycle","width":"half","bucket_status":{"mode":"all"}}]}}`,
		`{"dashboard":{"widgets":[{"id":"a","type":"graph","width":"half"}]}}`,
		`{"dashboard":{"widgets":[{"id":"a","type":"health","width":"third"}]}}`,
		`{"dashboard":{"widgets":[{"id":"a b","type":"health","width":"half"}]}}`,
		`{"dashboard":{"widgets":[{"type":"health","width":"half"}]}}`,
		`{"dashboard":{"widgets":[{"id":"a","type":"health","width":"half","title":"   "}]}}`,
		`{"dashboard":{"widgets":[{"id":"a","type":"health","width":"half","title":""}]}}`,
		`{"dashboard":{"widgets":[{"id":"a","type":"health","width":"half","title":"` + strings.Repeat("x", 41) + `"}]}}`,
	} {
		w := patch(body)
		if w.Code != http.StatusBadRequest || deref(decodeProblem(t, w).Code) != "invalid_request" {
			t.Errorf("%s: got %d %s", body, w.Code, w.Body)
		}
	}
}

// TestUsersSeeOnlyThemselves is the first "user A can't see user B" test;
// later features add their own with authtest.
func TestUsersSeeOnlyThemselves(t *testing.T) {
	e := setup(t)
	alice := authtest.NewUser(t, e.pool, "alice")
	bob := authtest.NewUser(t, e.pool, "bob")

	for user, c := range map[string]*http.Cookie{
		alice.ID: authtest.Login(t, e.h, "alice"),
		bob.ID:   authtest.Login(t, e.h, "bob"),
	} {
		if got := decodeUser(t, me(t, e, c)).Id; got != user {
			t.Errorf("/me returned user %s, want %s", got, user)
		}
	}
}
