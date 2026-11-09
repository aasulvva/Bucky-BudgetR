package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/logging"
)

const (
	// SessionCookie holds the session token. The __Host- prefix makes
	// browsers insist on Secure, Path=/ and no Domain.
	SessionCookie = "__Host-bucky_session"
	// CSRFHeader must be sent, with value "1", on every state-changing API
	// request. Browsers only let a page add custom headers to same-origin
	// requests (the API allows no CORS), so cross-site forms can't.
	CSRFHeader = "X-Bucky-CSRF"
)

type (
	sessionKey struct{}
	clientKey  struct{}
)

// sessionFrom returns the request's session, or nil if it has none.
func sessionFrom(ctx context.Context) *auth.Session {
	s, _ := ctx.Value(sessionKey{}).(*auth.Session)
	return s
}

// SessionFromContext returns the request's session, or nil if it has none.
// It's for handlers outside the spec (the debug routes), which the gate
// doesn't check.
func SessionFromContext(ctx context.Context) *auth.Session { return sessionFrom(ctx) }

func clientFrom(ctx context.Context) auth.Client {
	c, _ := ctx.Value(clientKey{}).(auth.Client)
	return c
}

// Sessions resolves the session cookie and stores the session (if valid) and
// the client's address in the context. A stale cookie is cleared. With a nil
// service, no request has a session.
func Sessions(svc *auth.Service, logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := context.WithValue(r.Context(), clientKey{}, auth.Client{
				IP:        ClientIPFromContext(r.Context()),
				UserAgent: r.UserAgent(),
			})
			if c, err := r.Cookie(SessionCookie); err == nil && c.Value != "" && svc != nil {
				sess, err := svc.Authenticate(ctx, c.Value)
				switch {
				case err == nil:
					ctx = context.WithValue(ctx, sessionKey{}, sess)
					logging.SetUser(ctx, sess.User.ID)
				case errors.Is(err, auth.ErrNoSession):
					http.SetCookie(w, clearedSessionCookie())
				default:
					logger.ErrorContext(ctx, "session lookup failed", slog.Any("error", err))
					WriteProblem(w, r.WithContext(ctx), http.StatusInternalServerError, "internal_error", "")
					return
				}
			}
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// CSRF rejects state-changing API requests that lack the CSRF header or come
// from another origin.
func CSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") || isSafeMethod(r.Method) {
			next.ServeHTTP(w, r)
			return
		}
		if r.Header.Get(CSRFHeader) != "1" {
			WriteProblem(w, r, http.StatusForbidden, "csrf", "Missing the "+CSRFHeader+" header.")
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			if u, err := url.Parse(origin); err != nil || u.Host != r.Host {
				WriteProblem(w, r, http.StatusForbidden, "csrf", "Cross-origin requests are not allowed.")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func isSafeMethod(m string) bool {
	return m == http.MethodGet || m == http.MethodHead || m == http.MethodOptions
}

func sessionCookie(token string, maxAge time.Duration) *http.Cookie {
	return &http.Cookie{
		Name:     SessionCookie,
		Value:    token,
		Path:     "/",
		MaxAge:   int(maxAge.Seconds()),
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	}
}

func clearedSessionCookie() *http.Cookie {
	return &http.Cookie{
		Name:     SessionCookie,
		Path:     "/",
		MaxAge:   -1,
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	}
}
