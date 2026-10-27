package httpapi

import (
	"context"
	"crypto/rand"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"regexp"
	"runtime/debug"
	"strings"
	"time"
)

// RequestIDHeader carries the request ID in both directions.
const RequestIDHeader = "X-Request-ID"

type requestIDKey struct{}

var validRequestID = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// RequestID gives every request an ID, stored in the context and echoed in the
// X-Request-ID response header. A well-formed incoming ID (for example from a
// reverse proxy) is kept; anything else is replaced.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(RequestIDHeader)
		if !validRequestID.MatchString(id) {
			id = rand.Text()
		}
		w.Header().Set(RequestIDHeader, id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey{}, id)))
	})
}

// RequestIDFromContext returns the ID set by RequestID, or "".
func RequestIDFromContext(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

type clientIPKey struct{}

// ClientAddr stores the client's IP address in the context, for login rate
// limiting and the access log. It is the connection's address; behind a
// trusted reverse proxy, the X-Forwarded-For address that proxy added. Other
// X-Forwarded-For headers are ignored, since clients can send anything.
func ClientAddr(trusted []netip.Prefix) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := context.WithValue(r.Context(), clientIPKey{}, clientIP(r, trusted))
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// ClientIPFromContext returns the address set by ClientAddr, or "".
func ClientIPFromContext(ctx context.Context) string {
	ip, _ := ctx.Value(clientIPKey{}).(string)
	return ip
}

// clientIP is the connection's address or, when that is a trusted proxy, the
// rightmost X-Forwarded-For address that isn't one: each proxy appends the
// address it got the request from, so hops further left could be forged.
func clientIP(r *http.Request, trusted []netip.Prefix) string {
	remote := r.RemoteAddr
	if host, _, err := net.SplitHostPort(remote); err == nil {
		remote = host
	}
	addr, err := netip.ParseAddr(remote)
	if err != nil || !isTrusted(addr, trusted) {
		return remote
	}
	hops := strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",")
	for i := len(hops) - 1; i >= 0; i-- {
		hop, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			return remote // missing or garbled: the proxy is all we know
		}
		if !isTrusted(hop.Unmap(), trusted) {
			return hop.Unmap().String()
		}
	}
	return remote
}

func isTrusted(addr netip.Addr, trusted []netip.Prefix) bool {
	addr = addr.Unmap()
	for _, p := range trusted {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

// AccessLog logs one line per request. Successful health checks are logged at
// debug level so that probes don't flood the log.
func AccessLog(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &responseRecorder{ResponseWriter: w}
			next.ServeHTTP(rec, r)

			level := slog.LevelInfo
			switch {
			case rec.status() >= 500:
				level = slog.LevelError
			case rec.status() < 400 && (r.URL.Path == "/healthz" || r.URL.Path == "/readyz"):
				level = slog.LevelDebug
			}
			logger.LogAttrs(r.Context(), level, "request",
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.Int("status", rec.status()),
				slog.Int("bytes", rec.bytes),
				slog.Duration("duration", time.Since(start)),
				slog.String("client_ip", ClientIPFromContext(r.Context())),
				slog.String("request_id", RequestIDFromContext(r.Context())),
			)
		})
	}
}

// Recover turns a panic in a handler into a logged error and a 500 problem
// response, so one bad request doesn't take down the server.
func Recover(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			rec := &responseRecorder{ResponseWriter: w}
			defer func() {
				v := recover()
				if v == nil {
					return
				}
				if v == http.ErrAbortHandler { //nolint:errorlint // sentinel compared as net/http does
					panic(v)
				}
				logger.ErrorContext(r.Context(), "panic in handler",
					slog.Any("panic", v),
					slog.String("stack", string(debug.Stack())),
					slog.String("request_id", RequestIDFromContext(r.Context())),
				)
				if !rec.wroteHeader {
					WriteProblem(rec, r, http.StatusInternalServerError, "internal_error", "")
				}
			}()
			next.ServeHTTP(rec, r)
		})
	}
}

// responseRecorder records the status code and body size of a response.
type responseRecorder struct {
	http.ResponseWriter
	code        int
	bytes       int
	wroteHeader bool
}

func (r *responseRecorder) WriteHeader(code int) {
	if !r.wroteHeader {
		r.code = code
		r.wroteHeader = true
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *responseRecorder) Write(b []byte) (int, error) {
	if !r.wroteHeader {
		r.WriteHeader(http.StatusOK)
	}
	n, err := r.ResponseWriter.Write(b)
	r.bytes += n
	return n, err
}

func (r *responseRecorder) status() int {
	if !r.wroteHeader {
		return http.StatusOK
	}
	return r.code
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (r *responseRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }
