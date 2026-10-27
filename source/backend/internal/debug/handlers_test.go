package debug

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

func decodeBody[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.NewDecoder(w.Body).Decode(&v); err != nil {
		t.Fatalf("decode %s: %v", w.Body, err)
	}
	return v
}

func TestRoutes(t *testing.T) {
	pool := testdb.New(t)
	ctx := t.Context()
	logger := slog.New(slog.DiscardHandler)
	d, err := Init(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	svc := auth.NewService(pool, logger, auth.Options{IdleTimeout: time.Hour, MaxAge: 24 * time.Hour})
	h, err := httpapi.NewHandler(logger, pool, httpapi.Options{Auth: svc, Debug: d.Register(logger)})
	if err != nil {
		t.Fatal(err)
	}
	authtest.NewUser(t, pool, "alice")
	c := authtest.Login(t, h, "alice")
	do := func(method, path string, body any) *httptest.ResponseRecorder {
		return authtest.Do(t, h, method, "/api/dev"+path, body, c)
	}

	if w := authtest.Do(t, h, http.MethodGet, "/api/dev/clock", nil, nil); w.Code != http.StatusUnauthorized {
		t.Errorf("without a session: %d", w.Code)
	}

	// The clock.
	if cl := decodeBody[clockJSON](t, do(http.MethodGet, "/clock", nil)); cl.Mode != Real {
		t.Errorf("clock %+v", cl)
	}
	target := time.Date(2026, 12, 24, 18, 0, 0, 0, time.UTC)
	w := do(http.MethodPut, "/clock", map[string]any{"at": target, "frozen": true})
	if cl := decodeBody[clockJSON](t, w); w.Code != http.StatusOK || cl.Mode != Frozen || !cl.Now.Equal(target) {
		t.Errorf("set: %d %+v", w.Code, cl)
	}
	if w := do(http.MethodPut, "/clock", map[string]any{"at": "tomorrow"}); w.Code != http.StatusBadRequest {
		t.Errorf("a bad time: %d", w.Code)
	}

	// Snapshots.
	if w := do(http.MethodPost, "/snapshots", map[string]any{"name": " "}); w.Code != http.StatusBadRequest {
		t.Errorf("a blank name: %d", w.Code)
	}
	w = do(http.MethodPost, "/snapshots", map[string]any{"name": "Christmas"})
	snap := decodeBody[snapshotJSON](t, w)
	if w.Code != http.StatusCreated || snap.Name != "Christmas" || !snap.Own || !snap.Restorable || !snap.TakenAt.Equal(target) {
		t.Fatalf("save: %d %+v", w.Code, snap)
	}
	if w := do(http.MethodPatch, "/snapshots/"+snap.ID, map[string]any{"name": "Xmas"}); w.Code != http.StatusNoContent {
		t.Errorf("rename: %d %s", w.Code, w.Body)
	}
	w = do(http.MethodGet, "/snapshots/"+snap.ID+"/export", nil)
	if w.Code != http.StatusOK || w.Header().Get("Content-Disposition") == "" {
		t.Fatalf("export: %d %v", w.Code, w.Header())
	}
	file := w.Body.Bytes()

	r := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/dev/snapshots/import", bytes.NewReader(file))
	r.Header.Set("X-Bucky-CSRF", "1")
	r.AddCookie(c)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if imported := decodeBody[snapshotJSON](t, w); w.Code != http.StatusCreated || imported.Name != "Xmas" || imported.ID == snap.ID {
		t.Errorf("import: %d %+v", w.Code, imported)
	}
	list := decodeBody[[]snapshotJSON](t, do(http.MethodGet, "/snapshots", nil))
	if len(list) != 2 || list[0].Username != "alice" {
		t.Errorf("list %+v", list)
	}

	if err := d.Clock.Set(ctx, nil, false); err != nil {
		t.Fatal(err)
	}
	w = do(http.MethodPost, "/snapshots/"+snap.ID+"/restore", map[string]any{"set_clock": true})
	if cl := decodeBody[clockJSON](t, w); w.Code != http.StatusOK || cl.Mode != Running {
		t.Errorf("restore: %d %+v", w.Code, cl)
	}
	if w := do(http.MethodDelete, "/snapshots/"+snap.ID, nil); w.Code != http.StatusNoContent {
		t.Errorf("delete: %d", w.Code)
	}
	if w := do(http.MethodPost, "/snapshots/"+snap.ID+"/restore", map[string]any{}); w.Code != http.StatusNotFound {
		t.Errorf("restore a deleted snapshot: %d", w.Code)
	}

	// Without the debug routes (production), /api/dev/ doesn't exist.
	prod, err := httpapi.NewHandler(logger, pool, httpapi.Options{Auth: svc})
	if err != nil {
		t.Fatal(err)
	}
	if w := authtest.Do(t, prod, http.MethodGet, "/api/dev/clock", nil, c); w.Code != http.StatusNotFound {
		t.Errorf("production: %d", w.Code)
	}
}
