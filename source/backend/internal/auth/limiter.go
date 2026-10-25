package auth

import (
	"sync"
	"time"
)

// Limiter slows down password guessing. After MaxFailures failed attempts for
// a key (an IP address or a username), the key is locked for a while; every
// further failure doubles the lockout, up to MaxLockout. Failures are
// forgotten after Window without a new one.
//
// It is in memory, which is enough for a single server instance.
type Limiter struct {
	MaxFailures int
	Window      time.Duration
	BaseLockout time.Duration
	MaxLockout  time.Duration
	now         func() time.Time

	mu      sync.Mutex
	entries map[string]*limiterEntry
}

type limiterEntry struct {
	failures    int
	lastFailure time.Time
	lockedUntil time.Time
}

// NewLimiter returns a limiter with the default policy: 5 failures within
// 15 minutes lock for 1 minute, doubling up to 15 minutes.
func NewLimiter(now func() time.Time) *Limiter {
	return &Limiter{
		MaxFailures: 5,
		Window:      15 * time.Minute,
		BaseLockout: time.Minute,
		MaxLockout:  15 * time.Minute,
		now:         now,
		entries:     make(map[string]*limiterEntry),
	}
}

// Wait returns how long to wait before another attempt for any of the keys
// is allowed; zero means go ahead.
func (l *Limiter) Wait(keys ...string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	var wait time.Duration
	for _, k := range keys {
		if e := l.entries[k]; e != nil && e.lockedUntil.After(now) {
			wait = max(wait, e.lockedUntil.Sub(now))
		}
	}
	return wait
}

// Fail records a failed attempt for each key.
func (l *Limiter) Fail(keys ...string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	for _, k := range keys {
		e := l.entries[k]
		if e == nil || now.Sub(e.lastFailure) > l.Window {
			e = &limiterEntry{}
			l.entries[k] = e
		}
		e.failures++
		e.lastFailure = now
		if over := e.failures - l.MaxFailures; over >= 0 {
			lockout := l.BaseLockout << min(over, 20)
			e.lockedUntil = now.Add(min(lockout, l.MaxLockout))
		}
	}
	if len(l.entries) > 10_000 {
		l.prune(now)
	}
}

// Reset forgets the failures for each key, e.g. after a successful login.
func (l *Limiter) Reset(keys ...string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, k := range keys {
		delete(l.entries, k)
	}
}

func (l *Limiter) prune(now time.Time) {
	for k, e := range l.entries {
		if now.Sub(e.lastFailure) > l.Window && !e.lockedUntil.After(now) {
			delete(l.entries, k)
		}
	}
}
