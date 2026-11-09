package logging

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
)

// ErrInvalid is returned for retention days out of range.
var ErrInvalid = errors.New("logging: invalid settings")

// MaxDays is the longest retention.
const MaxDays = 3650

// Service reads the kept entries for the Logs screen and keeps their
// retention (#93).
type Service struct {
	q      *sqlc.Queries
	logger *slog.Logger
	now    func() time.Time
}

// NewService returns a service using db. Log entries have the real time,
// so it keeps the real clock.
func NewService(db sqlc.DBTX, logger *slog.Logger) *Service {
	return &Service{q: sqlc.New(db), logger: logger, now: time.Now}
}

// Filter narrows the listed entries. Zero values don't filter.
type Filter struct {
	Kind      string      // KindLog, KindEvent or KindAudit
	MinLevel  *slog.Level // at least this level
	From, To  time.Time   // From ≤ at < To
	UserID    string
	RequestID string
	Q         string // text in the message, the event or the attributes
	Before    int64  // entries with a smaller ID (the cursor)
	Limit     int
}

// Listed is a kept entry with its ID and the user's name.
type Listed struct {
	ID int64
	Entry
	Username string
}

// List returns the entries matching f, newest first.
func (s *Service) List(ctx context.Context, f Filter) ([]Listed, error) {
	p := sqlc.ListLogEntriesParams{
		Kind:      text(f.Kind),
		FromAt:    pgtype.Timestamptz{Time: f.From, Valid: !f.From.IsZero()},
		ToAt:      pgtype.Timestamptz{Time: f.To, Valid: !f.To.IsZero()},
		UserID:    text(f.UserID),
		RequestID: text(f.RequestID),
		Q:         likeContains(f.Q),
		Before:    pgtype.Int8{Int64: f.Before, Valid: f.Before > 0},
		Lim:       int32(f.Limit), //nolint:gosec // limited by the API
	}
	if f.MinLevel != nil {
		p.MinLevel = pgtype.Int2{Int16: int16(*f.MinLevel), Valid: true} //nolint:gosec // slog levels are small
	}
	rows, err := s.q.ListLogEntries(ctx, p)
	if err != nil {
		return nil, err
	}
	out := make([]Listed, len(rows))
	for i, r := range rows {
		attrs := map[string]any{}
		_ = json.Unmarshal(r.Attrs, &attrs)
		out[i] = Listed{
			ID: r.ID,
			Entry: Entry{
				At: r.At, Level: slog.Level(r.Level), Kind: r.Kind, Message: r.Message,
				Event: r.Event.String, RequestID: r.RequestID.String, UserID: r.UserID.String,
				Attrs: attrs,
			},
			Username: r.Username.String,
		}
	}
	return out, nil
}

// Settings is how long entries are kept, in days.
type Settings struct {
	EventDays int // app events
	ErrorDays int // warnings and errors
	AuditDays int // admin actions
}

func (st Settings) valid() bool {
	for _, d := range []int{st.EventDays, st.ErrorDays, st.AuditDays} {
		if d < 1 || d > MaxDays {
			return false
		}
	}
	return true
}

// Settings returns the retention.
func (s *Service) Settings(ctx context.Context) (Settings, error) {
	r, err := s.q.GetLogSettings(ctx)
	return Settings{EventDays: int(r.EventDays), ErrorDays: int(r.ErrorDays), AuditDays: int(r.AuditDays)}, err
}

// UpdateSettings sets the retention, each 1–MaxDays days.
func (s *Service) UpdateSettings(ctx context.Context, st Settings) (Settings, error) {
	if !st.valid() {
		return Settings{}, ErrInvalid
	}
	r, err := s.q.UpdateLogSettings(ctx, sqlc.UpdateLogSettingsParams{
		EventDays: int32(st.EventDays), //nolint:gosec // checked above
		ErrorDays: int32(st.ErrorDays), //nolint:gosec // checked above
		AuditDays: int32(st.AuditDays), //nolint:gosec // checked above
	})
	return Settings{EventDays: int(r.EventDays), ErrorDays: int(r.ErrorDays), AuditDays: int(r.AuditDays)}, err
}

// Cleanup deletes the entries older than their retention.
func (s *Service) Cleanup(ctx context.Context) (int64, error) {
	return s.q.DeleteOldLogEntries(ctx, s.now())
}

// CleanupLoop runs Cleanup every interval until ctx is done.
func (s *Service) CleanupLoop(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			n, err := s.Cleanup(ctx)
			if err != nil && ctx.Err() == nil {
				s.logger.WarnContext(ctx, "log cleanup failed", slog.Any("error", err))
			}
			if n > 0 {
				s.logger.DebugContext(ctx, "deleted old log entries", slog.Int64("count", n))
			}
		}
	}
}

var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

// likeContains is a LIKE pattern matching text that contains s, or null for
// an empty s.
func likeContains(s string) pgtype.Text {
	if s = strings.TrimSpace(s); s == "" {
		return pgtype.Text{}
	}
	return text("%" + likeEscaper.Replace(s) + "%")
}
