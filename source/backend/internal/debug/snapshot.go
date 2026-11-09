package debug

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/userdata"
)

// A snapshot holds everything that belongs to one user (userdata.Read).
// Restoring it replaces that user's data with the snapshot's, keeping the
// IDs when the snapshot is the user's own, or with new IDs when it's someone
// else's (a clone).

var (
	ErrNotFound = errors.New("snapshot not found")
	// ErrSchema means the snapshot was taken at another schema version.
	ErrSchema = errors.New("snapshot from another schema version")
	// ErrInvalid means an imported snapshot isn't one.
	ErrInvalid = userdata.ErrInvalid
)

// Data is a snapshot's content.
type Data = userdata.Data

// Snapshot is a saved snapshot without its data.
type Snapshot struct {
	ID            int64
	UserID        string
	Username      string // "" if the user isn't in this database
	Name          string
	TakenAt       time.Time
	CreatedAt     time.Time
	SchemaVersion int64
	Size          int64 // bytes
}

// Export is a snapshot as a file.
type Export struct {
	Format        int       `json:"format"`
	SchemaVersion int64     `json:"schema_version"`
	UserID        string    `json:"user_id"`
	Name          string    `json:"name"`
	TakenAt       time.Time `json:"taken_at"`
	Data          Data      `json:"data"`
}

const exportFormat = 1

func schemaVersion(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}) (int64, error) {
	return userdata.SchemaVersion(ctx, q)
}

// Save takes a snapshot of the user's data, at the clock's time.
func (d *Debug) Save(ctx context.Context, userID, name string) (Snapshot, error) {
	var s Snapshot
	err := pgx.BeginTxFunc(ctx, d.pool, pgx.TxOptions{IsoLevel: pgx.RepeatableRead}, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		data, err := userdata.Read(ctx, tx, userID)
		if err != nil {
			return err
		}
		version, err := schemaVersion(ctx, tx)
		if err != nil {
			return err
		}
		id, err := insertSnapshot(ctx, tx, userID, name, d.Clock.Now(), version, data)
		if err != nil {
			return err
		}
		s, err = get(ctx, tx, id)
		return err
	})
	return s, err
}

func insertSnapshot(ctx context.Context, tx pgx.Tx, userID, name string, takenAt time.Time, version int64, data Data) (int64, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return 0, err
	}
	var id int64
	err = tx.QueryRow(ctx, `
		INSERT INTO debug_snapshots (user_id, name, taken_at, schema_version, data)
		VALUES ($1, $2, $3, $4, $5) RETURNING id`, userID, name, takenAt, version, raw).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("save snapshot: %w", err)
	}
	return id, nil
}

const listColumns = `s.id, s.user_id, coalesce(u.username, ''), s.name, s.taken_at, s.created_at,
	s.schema_version, octet_length(s.data::text)`

func scanSnapshot(r pgx.Row) (Snapshot, error) {
	var s Snapshot
	err := r.Scan(&s.ID, &s.UserID, &s.Username, &s.Name, &s.TakenAt, &s.CreatedAt, &s.SchemaVersion, &s.Size)
	return s, err
}

func get(ctx context.Context, tx pgx.Tx, id int64) (Snapshot, error) {
	s, err := scanSnapshot(tx.QueryRow(ctx, `SELECT `+listColumns+`
		FROM debug_snapshots s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Snapshot{}, ErrNotFound
	}
	return s, err
}

// List returns every snapshot, newest first.
func (d *Debug) List(ctx context.Context) ([]Snapshot, error) {
	rows, err := d.pool.Query(ctx, `SELECT `+listColumns+`
		FROM debug_snapshots s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.created_at DESC, s.id DESC`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Snapshot, error) { return scanSnapshot(r) })
}

// Rename renames a snapshot.
func (d *Debug) Rename(ctx context.Context, id int64, name string) error {
	return d.affect(ctx, `UPDATE debug_snapshots SET name = $2 WHERE id = $1`, id, name)
}

// Delete deletes a snapshot.
func (d *Debug) Delete(ctx context.Context, id int64) error {
	return d.affect(ctx, `DELETE FROM debug_snapshots WHERE id = $1`, id)
}

func (d *Debug) affect(ctx context.Context, sql string, args ...any) error {
	tag, err := d.pool.Exec(ctx, sql, args...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Export returns a snapshot as a file.
func (d *Debug) Export(ctx context.Context, id int64) (Export, error) {
	e := Export{Format: exportFormat}
	var raw []byte
	err := d.pool.QueryRow(ctx, `SELECT user_id, name, taken_at, schema_version, data FROM debug_snapshots WHERE id = $1`, id).
		Scan(&e.UserID, &e.Name, &e.TakenAt, &e.SchemaVersion, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return Export{}, ErrNotFound
	}
	if err != nil {
		return Export{}, err
	}
	if err := userdata.Decode(raw, &e.Data); err != nil {
		return Export{}, err
	}
	return e, nil
}

// Import saves an exported snapshot.
func (d *Debug) Import(ctx context.Context, e Export) (Snapshot, error) {
	if e.Format != exportFormat || e.UserID == "" || e.Data.Tables == nil || len(e.Data.Preferences) == 0 {
		return Snapshot{}, ErrInvalid
	}
	for name := range e.Data.Tables {
		if !userdata.Known(name) {
			return Snapshot{}, fmt.Errorf("%w: unknown table %q", ErrInvalid, name)
		}
	}
	if strings.TrimSpace(e.Name) == "" {
		e.Name = "Imported"
	}
	var s Snapshot
	err := pgx.BeginFunc(ctx, d.pool, func(tx pgx.Tx) error {
		id, err := insertSnapshot(ctx, tx, e.UserID, e.Name, e.TakenAt, e.SchemaVersion, e.Data)
		if err != nil {
			return err
		}
		s, err = get(ctx, tx, id)
		return err
	})
	return s, err
}

// Restore replaces userID's data with the snapshot's. With setClock, the
// clock moves to the snapshot's time, keeping its mode (running or frozen).
// It returns the snapshot's time.
func (d *Debug) Restore(ctx context.Context, id int64, userID string, setClock bool) (time.Time, error) {
	var (
		owner   string
		takenAt time.Time
		version int64
		raw     []byte
	)
	err := d.pool.QueryRow(ctx, `SELECT user_id, taken_at, schema_version, data FROM debug_snapshots WHERE id = $1`, id).
		Scan(&owner, &takenAt, &version, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, ErrNotFound
	}
	if err != nil {
		return time.Time{}, err
	}
	var data Data
	if err := userdata.Decode(raw, &data); err != nil {
		return time.Time{}, err
	}

	err = pgx.BeginFunc(ctx, d.pool, func(tx pgx.Tx) error {
		current, err := schemaVersion(ctx, tx)
		if err != nil {
			return err
		}
		if version != current {
			return fmt.Errorf("%w: the snapshot is from schema %d, the database is at %d", ErrSchema, version, current)
		}
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		_, err = userdata.Replace(ctx, tx, userID, owner, data)
		return err
	})
	if err != nil {
		return time.Time{}, err
	}
	if setClock {
		frozen := d.Clock.State().Mode == Frozen
		if err := d.Clock.Set(ctx, &takenAt, frozen); err != nil {
			return time.Time{}, err
		}
	}
	return takenAt, nil
}
