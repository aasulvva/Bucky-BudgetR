// Package debug holds the development-only debug settings (#100): a fake
// clock for the whole server and snapshots of a user's data. Only a binary
// built with the debug tag links it (cmd/server/debug_on.go), and only with
// APP_ENV=development does that binary use it.
//
// Its tables are created at start (Init), not by migrations, so production
// databases never have them.
package debug

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Mode says how the clock runs.
type Mode string

const (
	// Real is the real time.
	Real Mode = "real"
	// Running is the real time moved by an offset, so it keeps ticking.
	Running Mode = "running"
	// Frozen stands still at one moment.
	Frozen Mode = "frozen"
)

// ClockState is what the clock is set to.
type ClockState struct {
	Mode Mode
	// Offset is added to the real time when Running.
	Offset time.Duration
	// At is the moment it stands at when Frozen.
	At time.Time
}

// Clock is the server's clock for the business services (accounts, buckets,
// cycles, refills, transactions). Auth keeps the real time, so moving the
// clock doesn't end sessions. The setting is kept in the database, so it
// survives restarts (air rebuilds the server on every change).
type Clock struct {
	pool *pgxpool.Pool
	real func() time.Time

	mu    sync.RWMutex
	state ClockState
}

// newClock returns a clock on real time; real is the real clock (time.Now
// outside tests).
func newClock(pool *pgxpool.Pool, real func() time.Time) *Clock {
	return &Clock{pool: pool, real: real, state: ClockState{Mode: Real}}
}

// Now returns the clock's time.
func (c *Clock) Now() time.Time {
	c.mu.RLock()
	s := c.state
	c.mu.RUnlock()
	switch s.Mode {
	case Frozen:
		return s.At
	case Running:
		return c.real().Add(s.Offset)
	default:
		return c.real()
	}
}

// RealNow returns the real time.
func (c *Clock) RealNow() time.Time { return c.real() }

// State returns what the clock is set to.
func (c *Clock) State() ClockState {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.state
}

// Set moves the clock to at, running from there or frozen. A nil at goes
// back to the real time.
func (c *Clock) Set(ctx context.Context, at *time.Time, frozen bool) error {
	s := ClockState{Mode: Real}
	switch {
	case at == nil:
	case frozen:
		s = ClockState{Mode: Frozen, At: at.UTC()}
	default:
		s = ClockState{Mode: Running, Offset: at.Sub(c.real())}
	}
	var frozenAt *time.Time
	if s.Mode == Frozen {
		frozenAt = &s.At
	}
	_, err := c.pool.Exec(ctx, `
		INSERT INTO debug_clock (id, mode, offset_us, frozen_at) VALUES (true, $1, $2, $3)
		ON CONFLICT (id) DO UPDATE SET mode = $1, offset_us = $2, frozen_at = $3`,
		string(s.Mode), s.Offset.Microseconds(), frozenAt)
	if err != nil {
		return fmt.Errorf("save clock: %w", err)
	}
	c.mu.Lock()
	c.state = s
	c.mu.Unlock()
	return nil
}

// load reads the saved setting.
func (c *Clock) load(ctx context.Context) error {
	var (
		mode     string
		offsetUS int64
		frozenAt *time.Time
	)
	err := c.pool.QueryRow(ctx, `SELECT mode, offset_us, frozen_at FROM debug_clock`).Scan(&mode, &offsetUS, &frozenAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load clock: %w", err)
	}
	s := ClockState{Mode: Mode(mode), Offset: time.Duration(offsetUS) * time.Microsecond}
	if frozenAt != nil {
		s.At = frozenAt.UTC()
	}
	c.mu.Lock()
	c.state = s
	c.mu.Unlock()
	return nil
}
