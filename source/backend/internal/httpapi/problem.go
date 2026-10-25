package httpapi

import (
	"encoding/json"
	"net/http"
)

// Problem is an RFC 9457 problem details object, the body of every error
// response. Code is a stable, machine-readable error code and RequestID matches
// the X-Request-ID response header.
type Problem struct {
	Type      string `json:"type"`
	Title     string `json:"title"`
	Status    int    `json:"status"`
	Detail    string `json:"detail,omitempty"`
	Instance  string `json:"instance,omitempty"`
	Code      string `json:"code,omitempty"`
	RequestID string `json:"request_id,omitempty"`
}

// WriteProblem writes an application/problem+json response with the standard
// status text as its title. code and detail may be empty.
func WriteProblem(w http.ResponseWriter, r *http.Request, status int, code, detail string) {
	p := Problem{
		Type:      "about:blank",
		Title:     http.StatusText(status),
		Status:    status,
		Detail:    detail,
		Instance:  r.URL.Path,
		Code:      code,
		RequestID: RequestIDFromContext(r.Context()),
	}
	writeJSON(w, "application/problem+json", status, p)
}

func writeJSON(w http.ResponseWriter, contentType string, status int, v any) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
