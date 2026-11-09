package httpapi

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/logging"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/userdata"
)

// The user's data export and import (#36).

func (s *server) ExportMyData(ctx context.Context, _ api.ExportMyDataRequestObject) (api.ExportMyDataResponseObject, error) {
	svc, err := s.userDataService()
	if err != nil {
		return nil, err
	}
	f, err := svc.Export(ctx, sessionFrom(ctx).User.ID)
	if err != nil {
		return nil, err
	}
	var prefs map[string]any
	if err := userdata.Decode(f.Data.Preferences, &prefs); err != nil {
		return nil, err
	}
	out := api.ExportMyData200JSONResponse{
		App:           api.BuckyBudgetr,
		Format:        f.Format,
		SchemaVersion: f.SchemaVersion,
		ExportedAt:    f.ExportedAt,
		UserId:        f.UserID,
		Username:      f.Username,
	}
	out.Data.Preferences = prefs
	out.Data.Tables = f.Data.Tables
	c := userdata.CountOf(f.Data)
	s.logger.InfoContext(ctx, "data exported", slog.String(logging.EventKey, "data.exported"),
		slog.Int("accounts", c.Accounts), slog.Int("transactions", c.Transactions))
	return out, nil
}

func (s *server) ImportMyData(ctx context.Context, req api.ImportMyDataRequestObject) (api.ImportMyDataResponseObject, error) {
	svc, err := s.userDataService()
	if err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(req.Body)
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return nil, NewError(http.StatusRequestEntityTooLarge, "body_too_large", "")
	}
	if err != nil {
		return nil, err
	}
	f, err := userdata.ParseFile(raw)
	if err == nil {
		var c userdata.Counts
		if c, err = svc.Import(ctx, sessionFrom(ctx).User.ID, f); err == nil {
			s.logger.InfoContext(ctx, "data imported", slog.String(logging.EventKey, "data.imported"),
				slog.Bool("own", f.UserID == sessionFrom(ctx).User.ID), slog.Int("format", f.Format),
				slog.Int("accounts", c.Accounts), slog.Int("transactions", c.Transactions))
			return api.ImportMyData200JSONResponse{
				Accounts: c.Accounts, Buckets: c.Buckets, Cycles: c.Cycles,
				Transactions: c.Transactions, Schedules: c.Schedules,
			}, nil
		}
	}
	switch {
	case errors.Is(err, userdata.ErrNewer):
		return nil, &Error{Status: http.StatusConflict, Code: "export_too_new",
			Detail: "This export is from a newer version of the app. Update the app first.", Err: err}
	case errors.Is(err, userdata.ErrInvalid):
		return nil, &Error{Status: http.StatusBadRequest, Code: "invalid_export",
			Detail: "This file isn't a Bucky BudgetR export, or it's damaged.", Err: err}
	}
	return nil, err
}

func (s *server) userDataService() (*userdata.Service, error) {
	if s.userData == nil {
		return nil, NewError(http.StatusServiceUnavailable, "user_data_unavailable", "")
	}
	return s.userData, nil
}
