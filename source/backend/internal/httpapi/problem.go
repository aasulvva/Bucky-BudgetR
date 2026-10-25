package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
)

// Error is an error with an HTTP status. A handler returns it to answer with a
// problem response; any other error becomes a 500.
type Error struct {
	Status int
	Code   string      // machine-readable, e.g. "not_found"
	Detail string      // shown to the client, so never include internals
	Err    error       // cause, logged but not sent
	Header http.Header // extra response headers, e.g. Retry-After
}

// NewError returns an *Error without an underlying cause.
func NewError(status int, code, detail string) *Error {
	return &Error{Status: status, Code: code, Detail: detail}
}

func (e *Error) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%d %s: %v", e.Status, e.Code, e.Err)
	}
	return fmt.Sprintf("%d %s", e.Status, e.Code)
}

func (e *Error) Unwrap() error { return e.Err }

// WriteProblem writes an RFC 9457 application/problem+json response (schema
// Problem in api/openapi.yaml) with the standard status text as its title.
// code and detail may be empty.
func WriteProblem(w http.ResponseWriter, r *http.Request, status int, code, detail string) {
	p := api.Problem{
		Type:      "about:blank",
		Title:     http.StatusText(status),
		Status:    status,
		Detail:    optional(detail),
		Instance:  optional(r.URL.Path),
		Code:      optional(code),
		RequestId: optional(RequestIDFromContext(r.Context())),
	}
	writeJSON(w, "application/problem+json", status, p)
}

func writeJSON(w http.ResponseWriter, contentType string, status int, v any) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
