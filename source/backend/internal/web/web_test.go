package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

var dist = fstest.MapFS{
	"index.html":         {Data: []byte("<!doctype html><title>Bucky</title>")},
	"assets/app-1a2b.js": {Data: []byte("console.log(1)")},
	"favicon.svg":        {Data: []byte("<svg/>")},
}

func get(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil))
	return w
}

func TestHandler(t *testing.T) {
	h := newHandler(dist)
	for _, path := range []string{"/", "/index.html", "/admin", "/transactions/123/edit", "/set-password"} {
		w := get(t, h, path)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "<title>Bucky</title>") {
			t.Errorf("%s: %d %q", path, w.Code, w.Body)
		}
		if got := w.Header().Get("Cache-Control"); got != "no-cache" {
			t.Errorf("%s: Cache-Control %q", path, got)
		}
		if csp := w.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "frame-ancestors 'none'") {
			t.Errorf("%s: CSP %q", path, csp)
		}
	}

	w := get(t, h, "/assets/app-1a2b.js")
	if w.Code != http.StatusOK || w.Body.String() != "console.log(1)" {
		t.Errorf("asset: %d %q", w.Code, w.Body)
	}
	if got := w.Header().Get("Cache-Control"); !strings.Contains(got, "immutable") {
		t.Errorf("asset Cache-Control %q", got)
	}
	if got := w.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("asset nosniff %q", got)
	}
	if got := get(t, h, "/favicon.svg").Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("other file Cache-Control %q", got)
	}
	if w := get(t, h, "/assets/gone-9z9z.js"); w.Code != http.StatusNotFound {
		t.Errorf("missing asset: %d", w.Code)
	}
	if w := get(t, h, "/../../etc/passwd"); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "Bucky") {
		t.Errorf("path outside dist: %d %q", w.Code, w.Body)
	}
}

func TestHandlerWithoutBuild(t *testing.T) {
	if w := get(t, newHandler(fstest.MapFS{".gitkeep": {}}), "/admin"); w.Code != http.StatusNotFound {
		t.Errorf("without a build: %d", w.Code)
	}
	// The embedded files compile and serve, whether or not a build is there.
	if w := get(t, Handler(), "/admin"); w.Code != http.StatusOK && w.Code != http.StatusNotFound {
		t.Errorf("embedded: %d", w.Code)
	}
}
