package debug

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
)

// The debug routes, under /api/dev/. They're outside the spec, so they check
// the session themselves. Any logged-in user may use them.

// maxImport is the largest snapshot file accepted.
const maxImport = 20 << 20

type clockJSON struct {
	Now     time.Time `json:"now"`
	RealNow time.Time `json:"real_now"`
	Mode    Mode      `json:"mode"`
}

type snapshotJSON struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	UserID        string    `json:"user_id"`
	Username      string    `json:"username"`
	Own           bool      `json:"own"`
	TakenAt       time.Time `json:"taken_at"`
	CreatedAt     time.Time `json:"created_at"`
	SchemaVersion int64     `json:"schema_version"`
	Restorable    bool      `json:"restorable"`
	Size          int64     `json:"size"`
}

// Register adds the debug routes to mux.
func (d *Debug) Register(logger *slog.Logger) func(*http.ServeMux) {
	return func(mux *http.ServeMux) {
		h := func(pattern string, f func(w http.ResponseWriter, r *http.Request, user *sqlc.User) error) {
			mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
				sess := httpapi.SessionFromContext(r.Context())
				if sess == nil {
					httpapi.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Log in first.")
					return
				}
				if err := f(w, r, &sess.User); err != nil {
					d.fail(w, r, logger, err)
				}
			})
		}
		h("GET /api/dev/clock", d.getClock)
		h("PUT /api/dev/clock", d.setClock)
		h("GET /api/dev/snapshots", d.list)
		h("POST /api/dev/snapshots", d.save)
		h("POST /api/dev/snapshots/import", d.importSnapshot)
		h("PATCH /api/dev/snapshots/{id}", d.rename)
		h("DELETE /api/dev/snapshots/{id}", d.delete)
		h("POST /api/dev/snapshots/{id}/restore", d.restore)
		h("GET /api/dev/snapshots/{id}/export", d.export)
	}
}

func (d *Debug) fail(w http.ResponseWriter, r *http.Request, logger *slog.Logger, err error) {
	var he *httpapi.Error
	switch {
	case errors.As(err, &he):
		httpapi.WriteProblem(w, r, he.Status, he.Code, he.Detail)
	case errors.Is(err, ErrNotFound):
		httpapi.WriteProblem(w, r, http.StatusNotFound, "not_found", "No such snapshot.")
	case errors.Is(err, ErrSchema), errors.Is(err, ErrInvalid):
		httpapi.WriteProblem(w, r, http.StatusUnprocessableEntity, "invalid_snapshot", err.Error())
	default:
		logger.ErrorContext(r.Context(), "debug request failed",
			slog.Any("error", err),
			slog.String("request_id", httpapi.RequestIDFromContext(r.Context())))
		httpapi.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", err.Error())
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) error {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	return json.NewEncoder(w).Encode(v)
}

func readJSON(w http.ResponseWriter, r *http.Request, limit int64, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return httpapi.NewError(http.StatusBadRequest, "invalid_request", "request body: "+err.Error())
	}
	return nil
}

func snapshotID(r *http.Request) (int64, error) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		return 0, ErrNotFound
	}
	return id, nil
}

func (d *Debug) clockJSON() clockJSON {
	return clockJSON{Now: d.Clock.Now().UTC(), RealNow: d.Clock.RealNow().UTC(), Mode: d.Clock.State().Mode}
}

func (d *Debug) getClock(w http.ResponseWriter, _ *http.Request, _ *sqlc.User) error {
	return writeJSON(w, http.StatusOK, d.clockJSON())
}

func (d *Debug) setClock(w http.ResponseWriter, r *http.Request, _ *sqlc.User) error {
	var body struct {
		At     *time.Time `json:"at"`
		Frozen bool       `json:"frozen"`
	}
	if err := readJSON(w, r, 1<<10, &body); err != nil {
		return err
	}
	if err := d.Clock.Set(r.Context(), body.At, body.Frozen); err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, d.clockJSON())
}

func (d *Debug) list(w http.ResponseWriter, r *http.Request, user *sqlc.User) error {
	snaps, err := d.List(r.Context())
	if err != nil {
		return err
	}
	current, err := schemaVersion(r.Context(), d.pool)
	if err != nil {
		return err
	}
	out := make([]snapshotJSON, len(snaps))
	for i, s := range snaps {
		out[i] = toJSON(s, user.ID, current)
	}
	return writeJSON(w, http.StatusOK, out)
}

func toJSON(s Snapshot, userID string, current int64) snapshotJSON {
	return snapshotJSON{
		ID: fmt.Sprint(s.ID), Name: s.Name, UserID: s.UserID, Username: s.Username, Own: s.UserID == userID,
		TakenAt: s.TakenAt.UTC(), CreatedAt: s.CreatedAt.UTC(), SchemaVersion: s.SchemaVersion,
		Restorable: s.SchemaVersion == current, Size: s.Size,
	}
}

type nameBody struct {
	Name string `json:"name"`
}

func (b nameBody) valid() error {
	if n := len([]rune(strings.TrimSpace(b.Name))); n == 0 || n > 100 {
		return httpapi.NewError(http.StatusBadRequest, "invalid_request", "The name must be 1 to 100 characters.")
	}
	return nil
}

func (d *Debug) save(w http.ResponseWriter, r *http.Request, user *sqlc.User) error {
	var body nameBody
	if err := readJSON(w, r, 1<<10, &body); err != nil {
		return err
	}
	if err := body.valid(); err != nil {
		return err
	}
	s, err := d.Save(r.Context(), user.ID, strings.TrimSpace(body.Name))
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusCreated, toJSON(s, user.ID, s.SchemaVersion))
}

func (d *Debug) rename(w http.ResponseWriter, r *http.Request, _ *sqlc.User) error {
	id, err := snapshotID(r)
	if err != nil {
		return err
	}
	var body nameBody
	if err := readJSON(w, r, 1<<10, &body); err != nil {
		return err
	}
	if err := body.valid(); err != nil {
		return err
	}
	if err := d.Rename(r.Context(), id, strings.TrimSpace(body.Name)); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (d *Debug) delete(w http.ResponseWriter, r *http.Request, _ *sqlc.User) error {
	id, err := snapshotID(r)
	if err != nil {
		return err
	}
	if err := d.Delete(r.Context(), id); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (d *Debug) restore(w http.ResponseWriter, r *http.Request, user *sqlc.User) error {
	id, err := snapshotID(r)
	if err != nil {
		return err
	}
	var body struct {
		SetClock bool `json:"set_clock"`
	}
	if err := readJSON(w, r, 1<<10, &body); err != nil {
		return err
	}
	if _, err := d.Restore(r.Context(), id, user.ID, body.SetClock); err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, d.clockJSON())
}

func (d *Debug) export(w http.ResponseWriter, r *http.Request, _ *sqlc.User) error {
	id, err := snapshotID(r)
	if err != nil {
		return err
	}
	e, err := d.Export(r.Context(), id)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="bucky-snapshot-%d.json"`, id))
	return writeJSON(w, http.StatusOK, e)
}

func (d *Debug) importSnapshot(w http.ResponseWriter, r *http.Request, user *sqlc.User) error {
	var e Export
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxImport))
	dec.UseNumber()
	if err := dec.Decode(&e); err != nil {
		return httpapi.NewError(http.StatusBadRequest, "invalid_request", "snapshot file: "+err.Error())
	}
	s, err := d.Import(r.Context(), e)
	if err != nil {
		return err
	}
	current, err := schemaVersion(r.Context(), d.pool)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusCreated, toJSON(s, user.ID, current))
}
