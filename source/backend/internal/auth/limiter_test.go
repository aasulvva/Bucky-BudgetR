package auth

import (
	"testing"
	"time"
)

func TestLimiter(t *testing.T) {
	now := time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)
	l := NewLimiter(func() time.Time { return now })

	for range 4 {
		l.Fail("ip:1", "user:a")
	}
	if w := l.Wait("ip:1", "user:a"); w != 0 {
		t.Fatalf("locked after 4 failures: %v", w)
	}

	l.Fail("ip:1", "user:a")
	if w := l.Wait("user:a"); w != time.Minute {
		t.Fatalf("after 5 failures wait %v, want 1m", w)
	}
	if w := l.Wait("user:b"); w != 0 {
		t.Errorf("other keys must not be locked: %v", w)
	}

	// Each further failure doubles the lockout, up to MaxLockout.
	for _, want := range []time.Duration{2 * time.Minute, 4 * time.Minute, 8 * time.Minute, 15 * time.Minute, 15 * time.Minute} {
		now = now.Add(l.Wait("user:a"))
		l.Fail("user:a")
		if w := l.Wait("user:a"); w != want {
			t.Fatalf("wait %v, want %v", w, want)
		}
	}

	// Wait reports the longest lockout among the keys.
	if w := l.Wait("ip:1", "user:a"); w != 15*time.Minute {
		t.Errorf("combined wait %v", w)
	}

	l.Reset("user:a")
	if w := l.Wait("user:a"); w != 0 {
		t.Errorf("still locked after Reset: %v", w)
	}

	// Failures are forgotten after the window.
	for range 4 {
		l.Fail("user:c")
	}
	now = now.Add(16 * time.Minute)
	l.Fail("user:c")
	if w := l.Wait("user:c"); w != 0 {
		t.Errorf("old failures still count: %v", w)
	}
}
