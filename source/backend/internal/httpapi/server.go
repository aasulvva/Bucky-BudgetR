// Package httpapi is the HTTP layer: routing, middleware and error responses.
// Routes and models are generated from api/openapi.yaml (package api).
package httpapi

import (
	"context"
	_ "embed"
	"errors"
	"log/slog"
	"net/http"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cycles"
)

// Pinger reports whether a dependency is reachable. *pgxpool.Pool implements it.
type Pinger interface {
	Ping(ctx context.Context) error
}

// Options configures the handler.
type Options struct {
	// Auth handles logins and sessions. Nil means nobody can log in, which is
	// only useful in tests of the public endpoints.
	Auth *auth.Service
	// Accounts manages bank accounts. Nil answers its endpoints with 503.
	Accounts *accounts.Service
	// Cycles manages budget cycles. Nil answers its endpoints with 503.
	Cycles *cycles.Service
	// Buckets manages buckets. Nil answers its endpoints with 503.
	Buckets *buckets.Service
	// Docs serves the interactive API docs at /api/docs and the spec at
	// /api/openapi.json. Meant for development only.
	Docs bool
}

// NewHandler returns the root handler with all routes and middleware.
func NewHandler(logger *slog.Logger, db Pinger, opts Options) (http.Handler, error) {
	mux := http.NewServeMux()

	strict := api.NewStrictHandlerWithOptions(&server{db: db, auth: opts.Auth, accounts: opts.Accounts, cycles: opts.Cycles, buckets: opts.Buckets}, nil, api.StrictHTTPServerOptions{
		RequestErrorHandlerFunc:  badRequest,
		ResponseErrorHandlerFunc: responseError(logger),
	})
	api.HandlerWithOptions(strict, api.StdHTTPServerOptions{
		BaseRouter:       mux,
		ErrorHandlerFunc: badRequest,
	})

	if opts.Docs {
		mux.HandleFunc("GET /api/docs", serveDocs)
		mux.HandleFunc("GET /api/openapi.json", serveSpec(logger))
	}

	gate, err := Gate()
	if err != nil {
		return nil, err
	}

	// Outermost first: request ID, access log, panic recovery, CSRF, session,
	// then the spec-driven gate (auth and validation) and the routes.
	h := problemOnUnmatched(mux)
	h = gate(h)
	h = Sessions(opts.Auth, logger)(h)
	h = CSRF(h)
	h = Recover(logger)(h)
	h = AccessLog(logger)(h)
	h = RequestID(h)
	return h, nil
}

// badRequest answers requests whose parameters or body don't match the spec.
// The generated binding errors name the offending parameter and are safe to show.
func badRequest(w http.ResponseWriter, r *http.Request, err error) {
	WriteProblem(w, r, http.StatusBadRequest, "invalid_request", err.Error())
}

// responseError turns an error returned by a handler into a problem response.
// An *Error is sent as is; anything else is logged and becomes a 500.
func responseError(logger *slog.Logger) func(http.ResponseWriter, *http.Request, error) {
	return func(w http.ResponseWriter, r *http.Request, err error) {
		var e *Error
		if !errors.As(err, &e) {
			e = &Error{Status: http.StatusInternalServerError, Code: "internal_error", Err: err}
		}
		if e.Status >= 500 {
			level := slog.LevelWarn
			if e.Status == http.StatusInternalServerError {
				level = slog.LevelError
			}
			logger.Log(r.Context(), level, "request failed",
				slog.String("code", e.Code),
				slog.Any("error", e.Err),
				slog.String("request_id", RequestIDFromContext(r.Context())))
		}
		for k, v := range e.Header {
			w.Header()[k] = v
		}
		WriteProblem(w, r, e.Status, e.Code, e.Detail)
	}
}

//go:embed docs.html
var docsPage []byte

func serveDocs(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(docsPage)
}

func serveSpec(logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		spec, err := api.GetSpecJSON()
		if err != nil {
			responseError(logger)(w, r, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(spec)
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
