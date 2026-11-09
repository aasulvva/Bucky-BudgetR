package logging

import (
	"context"
	"sync/atomic"
)

// Request is what the log knows about the HTTP request a record belongs to:
// its ID and, once the session is resolved, the user. It's mutable so that
// middleware outside the session (the access log) sees the user too.
type Request struct {
	ID   string
	user atomic.Pointer[string]
}

// UserID is the user set with SetUser, or "".
func (r *Request) UserID() string {
	if r == nil {
		return ""
	}
	if u := r.user.Load(); u != nil {
		return *u
	}
	return ""
}

type requestKey struct{}

// WithRequest returns a context carrying a new Request with this ID.
func WithRequest(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestKey{}, &Request{ID: id})
}

// RequestFrom returns the context's Request, or nil.
func RequestFrom(ctx context.Context) *Request {
	r, _ := ctx.Value(requestKey{}).(*Request)
	return r
}

// SetUser records the request's user, if the context has a Request.
func SetUser(ctx context.Context, userID string) {
	if r := RequestFrom(ctx); r != nil {
		r.user.Store(&userID)
	}
}
