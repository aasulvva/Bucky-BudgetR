package logging_test

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/logging"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

func list(t *testing.T, pool *pgxpool.Pool, f logging.Filter) []logging.Listed {
	t.Helper()
	if f.Limit == 0 {
		f.Limit = 100
	}
	got, err := logging.NewService(pool, slog.New(slog.DiscardHandler)).List(t.Context(), f)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func closeStore(t *testing.T, s *logging.Store) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := s.Close(ctx); err != nil {
		t.Fatal(err)
	}
}

// The store keeps warnings, errors, events and admin actions, and passes
// everything on to stdout as before (#93).
func TestStore(t *testing.T) {
	pool := testdb.New(t)
	var out bytes.Buffer
	store := logging.NewStore(slog.NewJSONHandler(&out, &slog.HandlerOptions{Level: slog.LevelWarn}))
	logger := store.Logger()
	ctx := t.Context()

	// Before Start, entries wait.
	logger.InfoContext(ctx, "starting", slog.String(logging.EventKey, "server.starting"))
	store.Start(sqlc.New(pool))

	logger.InfoContext(ctx, "plain info")
	logger.DebugContext(ctx, "debug event", slog.String(logging.EventKey, "nope"))
	reqCtx := logging.WithRequest(ctx, "req-1")
	logging.SetUser(reqCtx, "100001")
	logger.With(slog.String("component", "x")).WithGroup("g").ErrorContext(reqCtx, "it broke",
		slog.Any("error", errors.New("boom")), slog.Int("status", 500), slog.Duration("took", time.Second))
	logger.WarnContext(ctx, "routine failed", slog.String("user_id", "100002"))
	logger.InfoContext(reqCtx, "user created", slog.String(logging.AuditKey, "user.created"),
		slog.Group("target", slog.String("user_id", "100003"), slog.String("username", "bob")))
	closeStore(t, store)
	// After Close, records still reach stdout, and nothing breaks.
	logger.ErrorContext(ctx, "after close")

	got := list(t, pool, logging.Filter{})
	if len(got) != 4 {
		t.Fatalf("got %d entries, want 4: %+v", len(got), got)
	}
	audit, warn, failed, start := got[0], got[1], got[2], got[3] // newest first
	if start.Kind != logging.KindEvent || start.Event != "server.starting" || start.Message != "starting" {
		t.Errorf("startup event %+v", start)
	}
	if failed.Kind != logging.KindLog || failed.Level != slog.LevelError || failed.RequestID != "req-1" || failed.UserID != "100001" {
		t.Errorf("error %+v", failed)
	}
	if failed.Attrs["component"] != "x" || failed.Attrs["g.error"] != "boom" || failed.Attrs["g.status"] != float64(500) || failed.Attrs["g.took"] != "1s" {
		t.Errorf("error attrs %v", failed.Attrs)
	}
	if warn.Kind != logging.KindLog || warn.UserID != "100002" || warn.RequestID != "" {
		t.Errorf("warning %+v", warn)
	}
	if audit.Kind != logging.KindAudit || audit.Event != "user.created" || audit.UserID != "100001" ||
		audit.Attrs["target.user_id"] != "100003" || audit.Attrs["target.username"] != "bob" {
		t.Errorf("audit %+v", audit)
	}
	for _, msg := range []string{"it broke", "routine failed", "after close"} {
		if !strings.Contains(out.String(), msg) {
			t.Errorf("stdout lacks %q: %s", msg, out.String())
		}
	}
	if strings.Contains(out.String(), "plain info") {
		t.Error("stdout got an info record below its level")
	}
}

func TestStoreCloseWithoutStart(t *testing.T) {
	store := logging.NewStore(slog.DiscardHandler)
	store.Logger().Error("never written")
	closeStore(t, store) // doesn't wait for a writer that never ran
	store.Start(nil)     // too late: does nothing
	store.Logger().Error("dropped")
}

func TestListAndCleanup(t *testing.T) {
	pool := testdb.New(t)
	ctx := t.Context()
	now := time.Now().UTC()
	for _, e := range []struct {
		age   time.Duration
		level int
		kind  string
		msg   string
	}{
		{40 * 24 * time.Hour, 0, "event", "old event"},
		{20 * 24 * time.Hour, 0, "event", "new event"},
		{100 * 24 * time.Hour, 8, "log", "old error"},
		{40 * 24 * time.Hour, 4, "event", "warning event"}, // kept as a warning
		{400 * 24 * time.Hour, 0, "audit", "old audit"},
		{200 * 24 * time.Hour, 0, "audit", "new audit"},
	} {
		if _, err := pool.Exec(ctx,
			"INSERT INTO log_entries (at, level, kind, message, request_id, attrs) VALUES ($1, $2, $3, $4, $5, $6)",
			now.Add(-e.age), e.level, e.kind, e.msg, "r-"+strings.ReplaceAll(e.msg, " ", "-"),
			`{"path": "/api/v1/`+strings.ReplaceAll(e.msg, " ", "_")+`"}`); err != nil {
			t.Fatal(err)
		}
	}

	warn := slog.LevelWarn
	for name, tc := range map[string]struct {
		f    logging.Filter
		want []string
	}{
		"kind":     {logging.Filter{Kind: "audit"}, []string{"new audit", "old audit"}},
		"level":    {logging.Filter{MinLevel: &warn}, []string{"warning event", "old error"}},
		"request":  {logging.Filter{RequestID: "r-new-event"}, []string{"new event"}},
		"q":        {logging.Filter{Q: "OLD_ERR"}, []string{"old error"}}, // in attrs, ignoring case; _ is literal
		"from":     {logging.Filter{From: now.Add(-30 * 24 * time.Hour)}, []string{"new event"}},
		"to":       {logging.Filter{To: now.Add(-300 * 24 * time.Hour)}, []string{"old audit"}},
		"paginate": {logging.Filter{Limit: 2, Before: 5}, []string{"warning event", "old error"}},
	} {
		got := list(t, pool, tc.f)
		var msgs []string
		for _, e := range got {
			msgs = append(msgs, e.Message)
		}
		if strings.Join(msgs, ",") != strings.Join(tc.want, ",") {
			t.Errorf("%s: got %v, want %v", name, msgs, tc.want)
		}
	}

	svc := logging.NewService(pool, slog.New(slog.DiscardHandler))
	if _, err := svc.UpdateSettings(ctx, logging.Settings{EventDays: 0, ErrorDays: 90, AuditDays: 365}); !errors.Is(err, logging.ErrInvalid) {
		t.Errorf("0 days: got %v", err)
	}
	st, err := svc.Settings(ctx)
	if err != nil || st != (logging.Settings{EventDays: 30, ErrorDays: 90, AuditDays: 365}) {
		t.Fatalf("defaults %+v %v", st, err)
	}
	n, err := svc.Cleanup(ctx)
	if err != nil || n != 3 {
		t.Fatalf("deleted %d, %v; want 3", n, err)
	}
	var msgs []string
	for _, e := range list(t, pool, logging.Filter{}) {
		msgs = append(msgs, e.Message)
	}
	if got := strings.Join(msgs, ","); got != "new audit,warning event,new event" {
		t.Errorf("kept %s", got)
	}

	if _, err := svc.UpdateSettings(ctx, logging.Settings{EventDays: 30, ErrorDays: 30, AuditDays: 100}); err != nil {
		t.Fatal(err)
	}
	if n, err := svc.Cleanup(ctx); err != nil || n != 2 {
		t.Errorf("after shortening: deleted %d, %v; want 2", n, err)
	}
}
