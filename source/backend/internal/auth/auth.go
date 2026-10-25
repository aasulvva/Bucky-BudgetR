// Package auth handles users' passwords, login sessions and login rate
// limiting (spec §1). The HTTP side (cookies, CSRF, access rules) is in
// internal/httpapi.
//
// A session is a random token that the client keeps in a cookie. Only the
// token's SHA-256 is stored, together with when the session was last used
// and when it expires. A session ends after IdleTimeout without use, or
// MaxAge after login, whichever comes first.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
)

var (
	// ErrInvalidCredentials covers an unknown user, a wrong password and an
	// inactive user alike, so a failed login reveals nothing.
	ErrInvalidCredentials = errors.New("invalid credentials")
	// ErrNoSession means the token is unknown, expired or its user inactive.
	ErrNoSession = errors.New("no valid session")
)

// RateLimitedError means too many failed attempts; retry after RetryAfter.
type RateLimitedError struct {
	RetryAfter time.Duration
}

func (e *RateLimitedError) Error() string {
	return fmt.Sprintf("too many failed attempts, retry after %s", e.RetryAfter)
}

// Options configures a Service.
type Options struct {
	IdleTimeout time.Duration
	MaxAge      time.Duration
	// Now returns the current time; nil means time.Now. Tests inject a clock.
	Now func() time.Time
}

// Service manages logins and sessions.
type Service struct {
	pool    *pgxpool.Pool
	q       *sqlc.Queries
	opts    Options
	limiter *Limiter
	logger  *slog.Logger
}

// NewService returns a Service using pool.
func NewService(pool *pgxpool.Pool, logger *slog.Logger, opts Options) *Service {
	clock := opts.Now
	if clock == nil {
		clock = time.Now
	}
	now := func() time.Time { return clock().UTC() }
	opts.Now = now
	return &Service{pool: pool, q: sqlc.New(pool), opts: opts, limiter: NewLimiter(now), logger: logger}
}

// MaxAge is how long a session can last at most, for the cookie's Max-Age.
func (s *Service) MaxAge() time.Duration { return s.opts.MaxAge }

// Session is an authenticated session and its user.
type Session struct {
	User      sqlc.User
	TokenHash []byte
	ExpiresAt time.Time
}

// Client describes who is making a request, for sessions and rate limiting.
type Client struct {
	IP        string
	UserAgent string
}

// Login checks the credentials and starts a session. It returns the session
// and the token for the client's cookie.
func (s *Service) Login(ctx context.Context, username, password string, client Client) (*Session, string, error) {
	keys := []string{"ip:" + client.IP, "user:" + strings.ToLower(username)}
	if wait := s.limiter.Wait(keys...); wait > 0 {
		return nil, "", &RateLimitedError{RetryAfter: wait}
	}

	user, err := s.q.GetUserByUsername(ctx, username)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		CheckPassword(dummyHash(), password)
		s.limiter.Fail(keys...)
		return nil, "", ErrInvalidCredentials
	case err != nil:
		return nil, "", err
	}
	if !CheckPassword(user.PasswordHash, password) || !user.Active {
		s.limiter.Fail(keys...)
		return nil, "", ErrInvalidCredentials
	}
	// Forget this user's failures. The IP's count is left to expire, so one
	// valid account can't be used to reset it.
	s.limiter.Reset(keys[1])

	token, hash := newToken()
	now := s.opts.Now()
	sess := &Session{User: user, TokenHash: hash, ExpiresAt: now.Add(s.opts.MaxAge)}
	if err := s.q.CreateSession(ctx, sqlc.CreateSessionParams{
		TokenHash: hash,
		UserID:    user.ID,
		Now:       now,
		ExpiresAt: sess.ExpiresAt,
		UserAgent: truncate(client.UserAgent, 512),
		Ip:        client.IP,
	}); err != nil {
		return nil, "", fmt.Errorf("create session: %w", err)
	}
	return sess, token, nil
}

// Authenticate returns the session for a cookie token, or ErrNoSession.
func (s *Service) Authenticate(ctx context.Context, token string) (*Session, error) {
	hash := hashToken(token)
	row, err := s.q.GetSessionWithUser(ctx, hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNoSession
	}
	if err != nil {
		return nil, err
	}
	now := s.opts.Now()
	if !now.Before(row.Session.ExpiresAt) || now.Sub(row.Session.LastSeenAt) >= s.opts.IdleTimeout {
		if err := s.q.DeleteSession(ctx, hash); err != nil {
			return nil, err
		}
		return nil, ErrNoSession
	}
	if !row.User.Active {
		if err := s.q.DeleteUserSessions(ctx, row.User.ID); err != nil {
			return nil, err
		}
		return nil, ErrNoSession
	}
	// Record use at most once a minute, to keep writes down.
	if now.Sub(row.Session.LastSeenAt) >= time.Minute {
		if err := s.q.TouchSession(ctx, sqlc.TouchSessionParams{TokenHash: hash, LastSeenAt: now}); err != nil {
			return nil, err
		}
	}
	return &Session{User: row.User, TokenHash: hash, ExpiresAt: row.Session.ExpiresAt}, nil
}

// Logout ends the session.
func (s *Service) Logout(ctx context.Context, sess *Session) error {
	return s.q.DeleteSession(ctx, sess.TokenHash)
}

// ChangePassword sets a new password after checking the current one. It
// clears must_change_password and ends all of the user's other sessions.
func (s *Service) ChangePassword(ctx context.Context, sess *Session, current, next string) error {
	key := "password:" + sess.User.ID
	if wait := s.limiter.Wait(key); wait > 0 {
		return &RateLimitedError{RetryAfter: wait}
	}
	if !CheckPassword(sess.User.PasswordHash, current) {
		s.limiter.Fail(key)
		return ErrInvalidCredentials
	}
	if err := ValidateNewPassword(next, current); err != nil {
		return err
	}
	s.limiter.Reset(key)
	hash, err := HashPassword(next)
	if err != nil {
		return err
	}
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		if err := q.UpdatePassword(ctx, sqlc.UpdatePasswordParams{ID: sess.User.ID, PasswordHash: hash}); err != nil {
			return err
		}
		return q.DeleteOtherUserSessions(ctx, sqlc.DeleteOtherUserSessionsParams{UserID: sess.User.ID, Keep: sess.TokenHash})
	})
}

// UpdatePreferences merges patch (a JSON object; null values remove a key)
// into the user's preferences and returns the result.
func (s *Service) UpdatePreferences(ctx context.Context, userID string, patch []byte) ([]byte, error) {
	return s.q.UpdatePreferences(ctx, sqlc.UpdatePreferencesParams{ID: userID, Patch: patch})
}

// CleanupLoop deletes ended sessions every interval until ctx is done.
func (s *Service) CleanupLoop(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := s.DeleteEndedSessions(ctx); err != nil && ctx.Err() == nil {
				s.logger.WarnContext(ctx, "session cleanup failed", slog.Any("error", err))
			}
		}
	}
}

// DeleteEndedSessions deletes sessions past their idle or absolute limit.
func (s *Service) DeleteEndedSessions(ctx context.Context) error {
	now := s.opts.Now()
	n, err := s.q.DeleteExpiredSessions(ctx, sqlc.DeleteExpiredSessionsParams{
		Now:        now,
		IdleCutoff: now.Add(-s.opts.IdleTimeout),
	})
	if n > 0 {
		s.logger.DebugContext(ctx, "deleted ended sessions", slog.Int64("count", n))
	}
	return err
}

// newToken returns a random session token and its hash.
func newToken() (string, []byte) {
	b := make([]byte, 32)
	_, _ = rand.Read(b) // never fails; crypto/rand panics on failure
	token := base64.RawURLEncoding.EncodeToString(b)
	return token, hashToken(token)
}

func hashToken(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
