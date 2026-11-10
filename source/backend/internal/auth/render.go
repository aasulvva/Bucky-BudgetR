package auth

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// RenderTTL is how long a render token lasts at most. A report PDF (#127)
// takes seconds; the render ends the token as soon as it's done.
const RenderTTL = 2 * time.Minute

// renders are the render tokens in use, by hash. They live in memory only:
// one server process makes and checks them, and a restart ends any render.
type renders struct {
	mu sync.Mutex
	m  map[string]renderEntry
}

type renderEntry struct {
	userID  string
	expires time.Time
}

// StartRender makes a render token for a headless browser that renders a
// page as userID (#127). The session it gives (AuthenticateRender) only
// reads: the server refuses anything but GET and HEAD with it. Call end
// when the render is over; the token also expires after RenderTTL.
func (s *Service) StartRender(userID string) (token string, end func()) {
	token, hash := newToken()
	key := string(hash)
	now := s.opts.Now()
	s.renders.mu.Lock()
	for k, e := range s.renders.m {
		if !now.Before(e.expires) {
			delete(s.renders.m, k)
		}
	}
	s.renders.m[key] = renderEntry{userID: userID, expires: now.Add(RenderTTL)}
	s.renders.mu.Unlock()
	return token, func() {
		s.renders.mu.Lock()
		delete(s.renders.m, key)
		s.renders.mu.Unlock()
	}
}

// AuthenticateRender returns the read-only session for a render token, or
// ErrNoSession if it's unknown, ended or expired, or its user is inactive.
func (s *Service) AuthenticateRender(ctx context.Context, token string) (*Session, error) {
	key := string(hashToken(token))
	s.renders.mu.Lock()
	e, ok := s.renders.m[key]
	if ok && !s.opts.Now().Before(e.expires) {
		delete(s.renders.m, key)
		ok = false
	}
	s.renders.mu.Unlock()
	if !ok {
		return nil, ErrNoSession
	}
	user, err := s.q.GetUser(ctx, e.userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNoSession
	}
	if err != nil {
		return nil, err
	}
	if !user.Active {
		return nil, ErrNoSession
	}
	return &Session{User: user, ExpiresAt: e.expires, Render: true}, nil
}
