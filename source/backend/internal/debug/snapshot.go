package debug

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
)

// A snapshot holds everything that belongs to one user: their rows in the
// tables below and their preferences. Restoring it replaces that user's data
// with the snapshot's, keeping the IDs when the snapshot is the user's own,
// or with new IDs when it's someone else's (a clone).

var (
	ErrNotFound = errors.New("snapshot not found")
	// ErrSchema means the snapshot was taken at another schema version.
	ErrSchema = errors.New("snapshot from another schema version")
	// ErrInvalid means an imported snapshot isn't one.
	ErrInvalid = errors.New("invalid snapshot")
)

// table is a per-user table and how to find the user's rows in it.
type table struct {
	name  string
	where string // with $1 = the user ID
	order string
}

// tables are the per-user tables, parents first: the order to insert in, and
// reversed, to delete in.
var tables = []table{
	{"bank_accounts", "user_id = $1", "id"},
	{"cycles", "user_id = $1", "id"},
	{"buckets", "user_id = $1", "id"},
	{"tags", "user_id = $1", "id"},
	{"transaction_headers", "user_id = $1", "id"},
	{"bank_transactions", "account_id IN (SELECT id FROM bank_accounts WHERE user_id = $1)", "id"},
	{"bucket_transactions", "bucket_id IN (SELECT id FROM buckets WHERE user_id = $1)", "id"},
	{"transaction_tags", "user_id = $1", "transaction_id, tag_id"},
	{"refills", "user_id = $1", "bucket_id, cycle_id"},
}

type row = map[string]any

// Data is a snapshot's content.
type Data struct {
	Preferences json.RawMessage  `json:"preferences"`
	Tables      map[string][]row `json:"tables"`
}

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
	var v int64
	err := q.QueryRow(ctx, `SELECT coalesce(max(version_id), 0) FROM goose_db_version WHERE is_applied`).Scan(&v)
	if err != nil {
		return 0, fmt.Errorf("schema version: %w", err)
	}
	return v, nil
}

// Save takes a snapshot of the user's data, at the clock's time.
func (d *Debug) Save(ctx context.Context, userID, name string) (Snapshot, error) {
	var s Snapshot
	err := pgx.BeginTxFunc(ctx, d.pool, pgx.TxOptions{IsoLevel: pgx.RepeatableRead}, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		data, err := read(ctx, tx, userID)
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

// read returns the user's data.
func read(ctx context.Context, tx pgx.Tx, userID string) (Data, error) {
	data := Data{Tables: map[string][]row{}}
	if err := tx.QueryRow(ctx, `SELECT preferences FROM users WHERE id = $1`, userID).Scan(&data.Preferences); err != nil {
		return Data{}, fmt.Errorf("read preferences: %w", err)
	}
	for _, t := range tables {
		var raw []byte
		q := fmt.Sprintf(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY %s), '[]') FROM %s t WHERE %s`, t.order, t.name, t.where)
		if err := tx.QueryRow(ctx, q, userID).Scan(&raw); err != nil {
			return Data{}, fmt.Errorf("read %s: %w", t.name, err)
		}
		var rows []row
		if err := decode(raw, &rows); err != nil {
			return Data{}, fmt.Errorf("read %s: %w", t.name, err)
		}
		data.Tables[t.name] = rows
	}
	return data, nil
}

// decode unmarshals JSON keeping numbers exact (amounts are numeric).
func decode(raw []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	return dec.Decode(v)
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
	if err := decode(raw, &e.Data); err != nil {
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
		if !known(name) {
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

func known(name string) bool {
	for _, t := range tables {
		if t.name == name {
			return true
		}
	}
	return false
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
	if err := decode(raw, &data); err != nil {
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
		// The ledger is immutable (ledger_immutable triggers), so switch
		// triggers off for this transaction: in replica mode Postgres skips
		// ordinary triggers, foreign key checks included. It needs a
		// superuser, which the development database's role is.
		if _, err := tx.Exec(ctx, `SET LOCAL session_replication_role = replica`); err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "42501" {
				return errors.New("restoring a snapshot needs a superuser database role")
			}
			return err
		}
		keep := owner == userID
		if keep {
			if keep, err = idsFree(ctx, tx, userID, data); err != nil {
				return err
			}
		}
		if !keep {
			if data, err = remap(ctx, tx, userID, data); err != nil {
				return err
			}
		}
		return write(ctx, tx, userID, data)
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

// idsFree reports whether none of the snapshot's IDs belong to another user
// now, so it can be restored as it is. IDs are unique across users.
func idsFree(ctx context.Context, tx pgx.Tx, userID string, data Data) (bool, error) {
	for _, t := range []string{"bank_accounts", "cycles", "buckets", "tags", "transaction_headers"} {
		var taken bool
		err := tx.QueryRow(ctx, fmt.Sprintf(`
			SELECT EXISTS (SELECT 1 FROM %s WHERE id::text = ANY($1) AND user_id <> $2)`, t),
			keys(data.Tables[t], "id"), userID).Scan(&taken)
		if err != nil {
			return false, err
		}
		if taken {
			return false, nil
		}
	}
	return true, nil
}

// keys returns the rows' values of col as text.
func keys(rows []row, col string) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		if v := r[col]; v != nil {
			out = append(out, fmt.Sprint(v))
		}
	}
	return out
}

// write deletes the user's data and inserts data instead.
func write(ctx context.Context, tx pgx.Tx, userID string, data Data) error {
	for i := len(tables) - 1; i >= 0; i-- {
		t := tables[i]
		if _, err := tx.Exec(ctx, fmt.Sprintf(`DELETE FROM %s WHERE %s`, t.name, t.where), userID); err != nil {
			return fmt.Errorf("delete %s: %w", t.name, err)
		}
	}
	for _, t := range tables {
		rows := data.Tables[t.name]
		if len(rows) == 0 {
			continue
		}
		raw, err := json.Marshal(rows)
		if err != nil {
			return err
		}
		overriding := ""
		if t.name == "tags" {
			overriding = "OVERRIDING SYSTEM VALUE"
		}
		q := fmt.Sprintf(`INSERT INTO %[1]s %[2]s SELECT * FROM jsonb_populate_recordset(null::%[1]s, $1)`, t.name, overriding)
		if _, err := tx.Exec(ctx, q, raw); err != nil {
			return fmt.Errorf("insert %s: %w", t.name, err)
		}
	}
	// Tags restored from another database can be ahead of the sequence.
	if _, err := tx.Exec(ctx, `
		SELECT setval(s, greatest((SELECT max(id) FROM tags), coalesce(pg_sequence_last_value(s::regclass), 1)))
		FROM pg_get_serial_sequence('tags', 'id') s`); err != nil {
		return fmt.Errorf("tag sequence: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE users SET preferences = $2, modified_at = now() WHERE id = $1`, userID, []byte(data.Preferences)); err != nil {
		return fmt.Errorf("preferences: %w", err)
	}
	return nil
}
