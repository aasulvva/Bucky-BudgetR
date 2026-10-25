package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

type pingFunc func(context.Context) error

func (f pingFunc) Ping(ctx context.Context) error { return f(ctx) }

var dbUp = pingFunc(func(context.Context) error { return nil })

func discard() *slog.Logger { return slog.New(slog.DiscardHandler) }

func newHandler(t *testing.T, logger *slog.Logger, db httpapi.Pinger, opts httpapi.Options) http.Handler {
	t.Helper()
	h, err := httpapi.NewHandler(logger, db, opts)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func serve(t *testing.T, h http.Handler, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequestWithContext(t.Context(), method, path, nil))
	return w
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func decodeProblem(t *testing.T, w *httptest.ResponseRecorder) api.Problem {
	t.Helper()
	if ct := w.Header().Get("Content-Type"); ct != "application/problem+json" {
		t.Fatalf("Content-Type = %q, want application/problem+json", ct)
	}
	var p api.Problem
	if err := json.NewDecoder(w.Body).Decode(&p); err != nil {
		t.Fatal(err)
	}
	if p.Status != w.Code {
		t.Errorf("problem status %d != response status %d", p.Status, w.Code)
	}
	if id := deref(p.RequestId); id == "" || id != w.Header().Get(httpapi.RequestIDHeader) {
		t.Errorf("problem request_id %q does not match header %q", id, w.Header().Get(httpapi.RequestIDHeader))
	}
	return p
}

func TestHealthz(t *testing.T) {
	w := serve(t, newHandler(t, discard(), dbUp, httpapi.Options{}), http.MethodGet, "/healthz")
	if w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != `{"status":"ok"}` {
		t.Errorf("got %d %s", w.Code, w.Body)
	}
}

func TestReadyz(t *testing.T) {
	w := serve(t, newHandler(t, discard(), dbUp, httpapi.Options{}), http.MethodGet, "/readyz")
	if w.Code != http.StatusOK {
		t.Errorf("db up: got %d %s", w.Code, w.Body)
	}

	down := pingFunc(func(context.Context) error { return errors.New("connection refused") })
	w = serve(t, newHandler(t, discard(), down, httpapi.Options{}), http.MethodGet, "/readyz")
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("db down: got %d", w.Code)
	}
	if p := decodeProblem(t, w); deref(p.Code) != "database_unavailable" || strings.Contains(deref(p.Detail), "refused") {
		t.Errorf("unexpected problem %+v", p)
	}
}

func TestReadyzWithDatabase(t *testing.T) {
	pool := testdb.New(t)
	w := serve(t, newHandler(t, discard(), pool, httpapi.Options{}), http.MethodGet, "/readyz")
	if w.Code != http.StatusOK {
		t.Errorf("got %d %s", w.Code, w.Body)
	}
}

func TestDocs(t *testing.T) {
	h := newHandler(t, discard(), dbUp, httpapi.Options{Docs: true})

	w := serve(t, h, http.MethodGet, "/api/docs")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "createApiReference") {
		t.Errorf("docs page: got %d %s", w.Code, w.Body)
	}

	w = serve(t, h, http.MethodGet, "/api/openapi.json")
	var spec struct {
		OpenAPI string         `json:"openapi"`
		Paths   map[string]any `json:"paths"`
	}
	if err := json.NewDecoder(w.Body).Decode(&spec); err != nil {
		t.Fatal(err)
	}
	if spec.OpenAPI != "3.0.3" || spec.Paths["/healthz"] == nil {
		t.Errorf("unexpected spec: %+v", spec)
	}

	// Off unless asked for.
	h = newHandler(t, discard(), dbUp, httpapi.Options{})
	for _, path := range []string{"/api/docs", "/api/openapi.json"} {
		if w := serve(t, h, http.MethodGet, path); w.Code != http.StatusNotFound {
			t.Errorf("%s without docs: got %d", path, w.Code)
		}
	}
}

func TestUnmatchedRoutes(t *testing.T) {
	h := newHandler(t, discard(), dbUp, httpapi.Options{})

	w := serve(t, h, http.MethodGet, "/nope")
	if w.Code != http.StatusNotFound {
		t.Fatalf("got %d", w.Code)
	}
	if p := decodeProblem(t, w); deref(p.Code) != "not_found" || p.Title != "Not Found" || deref(p.Instance) != "/nope" {
		t.Errorf("unexpected problem %+v", p)
	}

	w = serve(t, h, http.MethodPost, "/healthz")
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("got %d", w.Code)
	}
	if allow := w.Header().Get("Allow"); !strings.Contains(allow, http.MethodGet) {
		t.Errorf("Allow = %q", allow)
	}
	if p := decodeProblem(t, w); deref(p.Code) != "method_not_allowed" {
		t.Errorf("unexpected problem %+v", p)
	}
}

func TestRequestID(t *testing.T) {
	var seen string
	h := httpapi.RequestID(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		seen = httpapi.RequestIDFromContext(r.Context())
	}))

	for _, tc := range []struct {
		name, incoming string
		keep           bool
	}{
		{"generated", "", false},
		{"propagated", "abc-123.X_y", true},
		{"invalid replaced", "bad id\n", false},
		{"too long replaced", strings.Repeat("a", 65), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", nil)
			if tc.incoming != "" {
				r.Header.Set(httpapi.RequestIDHeader, tc.incoming)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)

			got := w.Header().Get(httpapi.RequestIDHeader)
			if got == "" || got != seen {
				t.Fatalf("header %q, context %q", got, seen)
			}
			if (got == tc.incoming) != tc.keep {
				t.Errorf("incoming %q, got %q, keep=%v", tc.incoming, got, tc.keep)
			}
		})
	}
}

func TestRecover(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	h := httpapi.RequestID(httpapi.Recover(logger)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	})))

	w := serve(t, h, http.MethodGet, "/x")
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("got %d", w.Code)
	}
	if p := decodeProblem(t, w); deref(p.Code) != "internal_error" || strings.Contains(w.Body.String(), "boom") {
		t.Errorf("unexpected problem %+v", p)
	}
	if !strings.Contains(logs.String(), `"panic":"boom"`) || !strings.Contains(logs.String(), `"stack"`) {
		t.Errorf("panic not logged: %s", logs.String())
	}
}

func TestAccessLog(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	h := newHandler(t, logger, dbUp, httpapi.Options{})

	r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/nope", nil)
	r.Header.Set(httpapi.RequestIDHeader, "req-1")
	h.ServeHTTP(httptest.NewRecorder(), r)

	var line struct {
		Level, Msg, Method, Path string
		Status, Bytes            int
		RequestID                string `json:"request_id"`
		Duration                 *int64
	}
	if err := json.Unmarshal(logs.Bytes(), &line); err != nil {
		t.Fatalf("%v: %s", err, logs.String())
	}
	if line.Level != "INFO" || line.Msg != "request" || line.Method != http.MethodGet || line.Path != "/nope" ||
		line.Status != 404 || line.Bytes == 0 || line.RequestID != "req-1" || line.Duration == nil {
		t.Errorf("unexpected log line %s", logs.String())
	}

	logs.Reset()
	serve(t, h, http.MethodGet, "/healthz")
	if !strings.Contains(logs.String(), `"level":"DEBUG"`) {
		t.Errorf("health check not logged at debug: %s", logs.String())
	}
}
