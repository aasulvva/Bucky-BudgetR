// Package httpapi is the HTTP layer: routing, middleware and error responses.
package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"time"
)

// Pinger reports whether a dependency is reachable. *pgxpool.Pool implements it.
type Pinger interface {
	Ping(ctx context.Context) error
}

// NewHandler returns the root handler with all routes and middleware.
func NewHandler(logger *slog.Logger, db Pinger) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.HandleFunc("GET /readyz", handleReadyz(logger, db))

	h := problemOnUnmatched(mux)
	h = Recover(logger)(h)
	h = AccessLog(logger)(h)
	h = RequestID(h)
	return h
}

type status struct {
	Status string `json:"status"`
}

// handleHealthz reports that the process is up. It checks nothing else.
func handleHealthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, "application/json", http.StatusOK, status{"ok"})
}

// handleReadyz reports whether the server can handle requests, i.e. whether
// the database is reachable.
func handleReadyz(logger *slog.Logger, db Pinger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := db.Ping(ctx); err != nil {
			logger.WarnContext(r.Context(), "readiness check failed", slog.Any("error", err))
			WriteProblem(w, r, http.StatusServiceUnavailable, "database_unavailable", "The database is not reachable.")
			return
		}
		writeJSON(w, "application/json", http.StatusOK, status{"ok"})
	}
}

// problemOnUnmatched replaces ServeMux's plain-text 404 and 405 responses with
// problem details. The Allow header that ServeMux sets on a 405 is kept.
func problemOnUnmatched(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h, pattern := mux.Handler(r)
		if pattern != "" {
			mux.ServeHTTP(w, r)
			return
		}
		uw := &unmatchedWriter{ResponseWriter: w}
		h.ServeHTTP(uw, r)
		switch uw.code {
		case http.StatusNotFound:
			WriteProblem(w, r, http.StatusNotFound, "not_found", "")
		case http.StatusMethodNotAllowed:
			WriteProblem(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "")
		}
	})
}

// unmatchedWriter swallows 404 and 405 responses so a problem can be written in
// their place, and passes anything else through.
type unmatchedWriter struct {
	http.ResponseWriter
	code int
}

func (u *unmatchedWriter) swallow() bool {
	return u.code == http.StatusNotFound || u.code == http.StatusMethodNotAllowed
}

func (u *unmatchedWriter) WriteHeader(code int) {
	if u.code == 0 {
		u.code = code
	}
	if !u.swallow() {
		u.ResponseWriter.WriteHeader(code)
	}
}

func (u *unmatchedWriter) Write(b []byte) (int, error) {
	if u.code == 0 {
		u.WriteHeader(http.StatusOK)
	}
	if u.swallow() {
		return len(b), nil
	}
	return u.ResponseWriter.Write(b)
}
