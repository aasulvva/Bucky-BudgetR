package logging

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
)

// The attributes that make a record worth keeping, besides its level.
const (
	// EventKey names an app event (startup, migrations, routines), e.g.
	// "cycle.started". An Info record with it is kept as kind "event".
	EventKey = "event"
	// AuditKey names an admin action, e.g. "user.created". A record with it
	// is kept as kind "audit".
	AuditKey = "audit"
)

// Kinds of kept entries.
const (
	KindLog   = "log"   // a warning or error
	KindEvent = "event" // an app event
	KindAudit = "audit" // an admin action
)

const (
	bufferSize = 1000
	batchSize  = 100
)

// Entry is a kept log record.
type Entry struct {
	At        time.Time
	Level     slog.Level
	Kind      string
	Message   string
	Event     string
	RequestID string
	UserID    string
	Attrs     map[string]any
}

// Store keeps the records the Logs screen shows (#93) in log_entries:
// warnings and errors, app events and admin actions. Its handler passes every
// record on to the stdout handler as before, so it changes nothing there.
//
// Entries wait in a buffer until Start, since the first ones (startup,
// migrations) are logged before the table exists, and are written in batches
// by one goroutine. A full buffer drops entries rather than slow the app
// down. The store's own failures go to the stdout handler only.
type Store struct {
	next    slog.Handler
	ch      chan Entry
	done    chan struct{}
	dropped atomic.Int64

	mu      sync.RWMutex
	started bool
	closed  bool
}

// NewStore returns a store whose handler also writes to next.
func NewStore(next slog.Handler) *Store {
	return &Store{next: next, ch: make(chan Entry, bufferSize), done: make(chan struct{})}
}

// Logger returns a logger writing to the stdout handler and the store.
func (s *Store) Logger() *slog.Logger {
	return slog.New(&storeHandler{store: s, next: s.next})
}

// Start writes the buffered entries and those that follow with q.
func (s *Store) Start(q *sqlc.Queries) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.started || s.closed {
		return
	}
	s.started = true
	go s.run(q)
}

// Close stops taking entries and waits until the waiting ones are written,
// or ctx is done. Call it before the pool closes.
func (s *Store) Close(ctx context.Context) error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	close(s.ch)
	started := s.started
	s.mu.Unlock()
	if !started {
		return nil
	}
	select {
	case <-s.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Store) add(e Entry) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.closed {
		return
	}
	select {
	case s.ch <- e:
	default:
		s.dropped.Add(1)
	}
}

func (s *Store) run(q *sqlc.Queries) {
	defer close(s.done)
	batch := make([]Entry, 0, batchSize)
	for e := range s.ch {
		batch = append(batch[:0], e)
	fill:
		for len(batch) < batchSize {
			select {
			case e, ok := <-s.ch:
				if !ok {
					break fill
				}
				batch = append(batch, e)
			default:
				break fill
			}
		}
		s.write(q, batch)
		if n := s.dropped.Swap(0); n > 0 {
			s.warn("log entries dropped: the buffer was full", slog.Int64("count", n))
		}
	}
}

func (s *Store) write(q *sqlc.Queries, batch []Entry) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	rows := make([]sqlc.InsertLogEntriesParams, len(batch))
	for i, e := range batch {
		attrs, err := json.Marshal(e.Attrs)
		if err != nil || e.Attrs == nil {
			attrs = []byte("{}")
		}
		rows[i] = sqlc.InsertLogEntriesParams{
			At:        e.At.UTC(),
			Level:     int16(e.Level), //nolint:gosec // slog levels are small
			Kind:      e.Kind,
			Message:   e.Message,
			Event:     text(e.Event),
			RequestID: text(e.RequestID),
			UserID:    text(e.UserID),
			Attrs:     attrs,
		}
	}
	if _, err := q.InsertLogEntries(ctx, rows); err != nil {
		s.warn("storing log entries failed", slog.Int("count", len(rows)), slog.Any("error", err))
	}
}

// warn logs to the stdout handler only, so the store never logs into itself.
func (s *Store) warn(msg string, attrs ...slog.Attr) {
	ctx := context.Background()
	if !s.next.Enabled(ctx, slog.LevelWarn) {
		return
	}
	r := slog.NewRecord(time.Now(), slog.LevelWarn, msg, 0)
	r.AddAttrs(attrs...)
	_ = s.next.Handle(ctx, r)
}

func text(s string) pgtype.Text { return pgtype.Text{String: s, Valid: s != ""} }

// storeHandler hands every record to next and the ones worth keeping to the
// store.
type storeHandler struct {
	store  *Store
	next   slog.Handler
	attrs  []slog.Attr // from WithAttrs, keys prefixed with their groups
	prefix string      // the open groups, "a.b."
}

// Enabled is true from Info up even when the stdout level is higher, since
// events are kept whatever LOG_LEVEL is.
func (h *storeHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return level >= slog.LevelInfo || h.next.Enabled(ctx, level)
}

func (h *storeHandler) Handle(ctx context.Context, r slog.Record) error {
	var err error
	if h.next.Enabled(ctx, r.Level) {
		err = h.next.Handle(ctx, r)
	}
	if r.Level >= slog.LevelInfo {
		if e, ok := h.entry(ctx, r); ok {
			h.store.add(e)
		}
	}
	return err
}

func (h *storeHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	c := *h
	c.next = h.next.WithAttrs(attrs)
	c.attrs = append([]slog.Attr(nil), h.attrs...)
	for _, a := range attrs {
		c.attrs = append(c.attrs, slog.Attr{Key: h.prefix + a.Key, Value: a.Value})
	}
	return &c
}

func (h *storeHandler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	c := *h
	c.next = h.next.WithGroup(name)
	c.prefix = h.prefix + name + "."
	return &c
}

// entry turns a record into an entry, if it's one to keep.
func (h *storeHandler) entry(ctx context.Context, r slog.Record) (Entry, bool) {
	e := Entry{At: r.Time, Level: r.Level, Message: r.Message, Attrs: map[string]any{}}
	var audit string
	take := func(key string, v slog.Value) {
		v = v.Resolve()
		switch key {
		case EventKey, AuditKey, "request_id", "user_id":
			if v.Kind() == slog.KindString {
				switch key {
				case EventKey:
					e.Event = v.String()
				case AuditKey:
					audit = v.String()
				case "request_id":
					e.RequestID = v.String()
				case "user_id":
					e.UserID = v.String()
				}
				return
			}
		}
		flatten(e.Attrs, key, v)
	}
	for _, a := range h.attrs {
		take(a.Key, a.Value)
	}
	r.Attrs(func(a slog.Attr) bool {
		take(h.prefix+a.Key, a.Value)
		return true
	})

	switch {
	case audit != "":
		e.Kind, e.Event = KindAudit, audit
	case e.Event != "":
		e.Kind = KindEvent
	case r.Level >= slog.LevelWarn:
		e.Kind = KindLog
	default:
		return Entry{}, false
	}
	if req := RequestFrom(ctx); req != nil {
		if e.RequestID == "" {
			e.RequestID = req.ID
		}
		if e.UserID == "" {
			e.UserID = req.UserID()
		}
	}
	return e, true
}

// flatten adds an attribute to m, groups as "group.key".
func flatten(m map[string]any, key string, v slog.Value) {
	v = v.Resolve()
	if v.Kind() == slog.KindGroup {
		prefix := key
		if prefix != "" {
			prefix += "."
		}
		for _, a := range v.Group() {
			flatten(m, prefix+a.Key, a.Value)
		}
		return
	}
	if key == "" {
		return
	}
	m[key] = plain(v)
}

// plain is a JSON-friendly form of a value.
func plain(v slog.Value) any {
	switch v.Kind() {
	case slog.KindString:
		return v.String()
	case slog.KindInt64:
		return v.Int64()
	case slog.KindUint64:
		return v.Uint64()
	case slog.KindFloat64:
		return v.Float64()
	case slog.KindBool:
		return v.Bool()
	case slog.KindDuration:
		return v.Duration().String()
	case slog.KindTime:
		return v.Time().UTC().Format(time.RFC3339Nano)
	}
	switch a := v.Any().(type) {
	case nil:
		return nil
	case error:
		return a.Error()
	case fmt.Stringer:
		return a.String()
	default:
		return fmt.Sprint(a)
	}
}
