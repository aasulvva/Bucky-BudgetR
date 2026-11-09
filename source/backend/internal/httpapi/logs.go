package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/logging"
)

// The Logs screen (#93), admins only (x-admin-only).

func (s *server) ListLogEntries(ctx context.Context, req api.ListLogEntriesRequestObject) (api.ListLogEntriesResponseObject, error) {
	svc, err := s.logService()
	if err != nil {
		return nil, err
	}
	p := req.Params
	f := logging.Filter{Limit: 50}
	if p.Limit != nil {
		f.Limit = *p.Limit
	}
	if p.Kind != nil {
		f.Kind = string(*p.Kind)
	}
	if p.MinLevel != nil {
		level := slog.LevelWarn
		if *p.MinLevel == api.ListLogEntriesParamsMinLevelError {
			level = slog.LevelError
		}
		f.MinLevel = &level
	}
	if p.From != nil {
		f.From = *p.From
	}
	if p.To != nil {
		f.To = *p.To
	}
	if p.UserId != nil {
		f.UserID = *p.UserId
	}
	if p.RequestId != nil {
		f.RequestID = *p.RequestId
	}
	if p.Q != nil {
		f.Q = *p.Q
	}
	if p.Before != nil {
		f.Before = *p.Before
	}
	// One more than asked tells whether there's a next page.
	f.Limit++
	entries, err := svc.List(ctx, f)
	if err != nil {
		return nil, err
	}
	out := api.ListLogEntries200JSONResponse{Entries: make([]api.LogEntry, 0, len(entries))}
	if len(entries) == f.Limit {
		entries = entries[:f.Limit-1]
		next := entries[len(entries)-1].ID
		out.NextBefore = &next
	}
	for _, e := range entries {
		out.Entries = append(out.Entries, toAPILogEntry(e))
	}
	return out, nil
}

func toAPILogEntry(e logging.Listed) api.LogEntry {
	return api.LogEntry{
		Id:        e.ID,
		At:        e.At,
		Level:     levelName(e.Level),
		Kind:      api.LogKind(e.Kind),
		Message:   e.Message,
		Event:     optional(e.Event),
		RequestId: optional(e.RequestID),
		UserId:    optional(e.UserID),
		Username:  optional(e.Username),
		Attrs:     e.Attrs,
	}
}

func levelName(l slog.Level) api.LogEntryLevel {
	switch {
	case l >= slog.LevelError:
		return api.LogEntryLevelError
	case l >= slog.LevelWarn:
		return api.LogEntryLevelWarn
	case l >= slog.LevelInfo:
		return api.LogEntryLevelInfo
	}
	return api.LogEntryLevelDebug
}

func (s *server) GetLogSettings(ctx context.Context, _ api.GetLogSettingsRequestObject) (api.GetLogSettingsResponseObject, error) {
	svc, err := s.logService()
	if err != nil {
		return nil, err
	}
	st, err := svc.Settings(ctx)
	if err != nil {
		return nil, err
	}
	return api.GetLogSettings200JSONResponse(toAPILogSettings(st)), nil
}

func (s *server) UpdateLogSettings(ctx context.Context, req api.UpdateLogSettingsRequestObject) (api.UpdateLogSettingsResponseObject, error) {
	svc, err := s.logService()
	if err != nil {
		return nil, err
	}
	old, err := svc.Settings(ctx)
	if err != nil {
		return nil, err
	}
	st, err := svc.UpdateSettings(ctx, logging.Settings{
		EventDays: req.Body.EventDays, ErrorDays: req.Body.ErrorDays, AuditDays: req.Body.AuditDays,
	})
	if errors.Is(err, logging.ErrInvalid) {
		return nil, &Error{Status: http.StatusBadRequest, Code: "invalid_request",
			Detail: "Each retention is 1–3650 days."}
	}
	if err != nil {
		return nil, err
	}
	if st != old {
		s.audit(ctx, "log settings changed", "logs.settings_changed",
			slog.Group("old", slog.Int("event_days", old.EventDays), slog.Int("error_days", old.ErrorDays), slog.Int("audit_days", old.AuditDays)),
			slog.Group("new", slog.Int("event_days", st.EventDays), slog.Int("error_days", st.ErrorDays), slog.Int("audit_days", st.AuditDays)))
	}
	return api.UpdateLogSettings200JSONResponse(toAPILogSettings(st)), nil
}

func toAPILogSettings(st logging.Settings) api.LogSettings {
	return api.LogSettings{EventDays: st.EventDays, ErrorDays: st.ErrorDays, AuditDays: st.AuditDays}
}

func (s *server) logService() (*logging.Service, error) {
	if s.logs == nil {
		return nil, NewError(http.StatusServiceUnavailable, "logs_unavailable", "")
	}
	return s.logs, nil
}

// audit records an admin action (#93) for the Logs screen. The acting admin
// and the request come from the context. Never pass passwords, links or
// amounts.
func (s *server) audit(ctx context.Context, msg, action string, attrs ...any) {
	s.logger.InfoContext(ctx, msg, append([]any{slog.String(logging.AuditKey, action)}, attrs...)...)
}
