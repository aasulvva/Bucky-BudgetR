// Package userdata reads and replaces everything that belongs to one user:
// their rows in the per-user tables and their preferences. The data export
// and import (#36) and the development snapshots use it.
//
// Replacing keeps the IDs when the data is the user's own and no other user
// has them now; otherwise every ID gets a new one, with every reference
// following (remap.go).
package userdata

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
)

// ErrInvalid means the data can't be written: it isn't an export, or it's
// from a newer version of the app.
var ErrInvalid = errors.New("invalid user data")

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
	{"schedules", "user_id = $1", "id"},
	{"schedule_bucket_lines", "user_id = $1", "schedule_id, bucket_id"},
	{"schedule_occurrences", "user_id = $1", "id"},
	// The keys aren't remapped (see kKept).
	{"notification_dismissals", "user_id = $1", "key"},
}

// Row is one table row, by column name. Numbers are json.Number, so amounts
// stay exact.
type Row = map[string]any

type row = Row

// Data is everything a user has.
type Data struct {
	Preferences json.RawMessage  `json:"preferences"`
	Tables      map[string][]Row `json:"tables"`
}

// Known reports whether name is one of the per-user tables.
func Known(name string) bool {
	return slices.ContainsFunc(tables, func(t table) bool { return t.name == name })
}

// Read returns the user's data. Use a transaction that sees one moment
// (repeatable read) under the user's lock.
func Read(ctx context.Context, tx pgx.Tx, userID string) (Data, error) {
	data := Data{Tables: map[string][]Row{}}
	if err := tx.QueryRow(ctx, `SELECT preferences FROM users WHERE id = $1`, userID).Scan(&data.Preferences); err != nil {
		return Data{}, fmt.Errorf("read preferences: %w", err)
	}
	for _, t := range tables {
		var raw []byte
		q := fmt.Sprintf(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY %s), '[]') FROM %s t WHERE %s`, t.order, t.name, t.where)
		if err := tx.QueryRow(ctx, q, userID).Scan(&raw); err != nil {
			return Data{}, fmt.Errorf("read %s: %w", t.name, err)
		}
		var rows []Row
		if err := Decode(raw, &rows); err != nil {
			return Data{}, fmt.Errorf("read %s: %w", t.name, err)
		}
		data.Tables[t.name] = rows
	}
	return data, nil
}

// Decode unmarshals JSON keeping numbers exact (amounts are numeric).
func Decode(raw []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	return dec.Decode(v)
}

// Replace replaces userID's data with data, inside tx, under the user's lock.
// owner is whose data it was: with the user's own, the IDs are kept unless
// another user has them now. It returns the data as written.
//
// The ledger is immutable (ledger_immutable), except that a transaction
// that sets bucky.replacing_user_data may delete rows (migration 00023):
// Replace sets it for tx only.
func Replace(ctx context.Context, tx pgx.Tx, userID, owner string, data Data) (Data, error) {
	if data.Tables == nil || len(data.Preferences) == 0 {
		return Data{}, fmt.Errorf("%w: no data", ErrInvalid)
	}
	for name := range data.Tables {
		if !Known(name) {
			return Data{}, fmt.Errorf("%w: unknown table %q", ErrInvalid, name)
		}
	}
	keep := owner == userID
	if keep {
		var err error
		if keep, err = idsFree(ctx, tx, userID, data); err != nil {
			return Data{}, err
		}
	}
	var err error
	if keep {
		data, err = ownUsers(ctx, tx, userID, data)
	} else {
		data, err = remap(ctx, tx, userID, data)
	}
	if err != nil {
		return Data{}, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('bucky.replacing_user_data', 'on', true)`); err != nil {
		return Data{}, err
	}
	if err := write(ctx, tx, userID, data); err != nil {
		return Data{}, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('bucky.replacing_user_data', 'off', true)`); err != nil {
		return Data{}, err
	}
	return data, nil
}

// idsFree reports whether none of the data's IDs belong to another user
// now, so it can be written as it is. IDs are unique across users.
func idsFree(ctx context.Context, tx pgx.Tx, userID string, data Data) (bool, error) {
	for _, t := range []string{"bank_accounts", "cycles", "buckets", "tags", "transaction_headers", "schedules"} {
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

// ownUsers points user columns at userID: user_id always, and created_by
// when that user isn't in this database (data from another server).
func ownUsers(ctx context.Context, tx pgx.Tx, userID string, data Data) (Data, error) {
	var others []string
	for name, rows := range data.Tables {
		for col, k := range idColumns[name] {
			if k == kUser {
				others = append(others, keys(rows, col)...)
			}
		}
	}
	var existing []string
	if err := tx.QueryRow(ctx, `SELECT coalesce(array_agg(id), '{}') FROM users WHERE id = ANY($1)`,
		slices.Compact(slices.Sorted(slices.Values(others)))).Scan(&existing); err != nil {
		return Data{}, err
	}
	out := Data{Preferences: data.Preferences, Tables: map[string][]Row{}}
	for name, rows := range data.Tables {
		next := make([]Row, len(rows))
		for i, r := range rows {
			n := maps.Clone(r)
			for col, k := range idColumns[name] {
				if k != kUser || r[col] == nil {
					continue
				}
				if col == "user_id" || !slices.Contains(existing, fmt.Sprint(r[col])) {
					n[col] = userID
				}
			}
			next[i] = n
		}
		out.Tables[name] = next
	}
	return out, nil
}

// keys returns the rows' values of col as text.
func keys(rows []Row, col string) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		if v := r[col]; v != nil {
			out = append(out, fmt.Sprint(v))
		}
	}
	return out
}

// write deletes the user's data and inserts data instead. Each table is one
// INSERT, so rows that refer to each other (corrections) pass the foreign
// key checks at its end. Only the columns the rows have are written, so a
// column added since the data was read gets its default; a column the table
// doesn't have is refused.
func write(ctx context.Context, tx pgx.Tx, userID string, data Data) error {
	columns, err := tableColumns(ctx, tx)
	if err != nil {
		return err
	}
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
		var cols []string
		for _, r := range rows {
			for col := range r {
				if !slices.Contains(cols, col) {
					cols = append(cols, col)
				}
			}
		}
		slices.Sort(cols)
		quoted := make([]string, len(cols))
		for i, col := range cols {
			if !slices.Contains(columns[t.name], col) {
				return fmt.Errorf("%w: %s has no column %q (the data is from a newer version)", ErrInvalid, t.name, col)
			}
			quoted[i] = pgx.Identifier{col}.Sanitize()
		}
		raw, err := json.Marshal(rows)
		if err != nil {
			return err
		}
		overriding := ""
		if t.name == "tags" {
			overriding = "OVERRIDING SYSTEM VALUE"
		}
		list := strings.Join(quoted, ", ")
		q := fmt.Sprintf(`INSERT INTO %[1]s (%[2]s) %[3]s SELECT %[2]s FROM jsonb_populate_recordset(null::%[1]s, $1)`,
			t.name, list, overriding)
		if _, err := tx.Exec(ctx, q, raw); err != nil {
			return fmt.Errorf("insert %s: %w", t.name, err)
		}
	}
	// Tags from another database can be ahead of the sequence.
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

// tableColumns returns each per-user table's columns.
func tableColumns(ctx context.Context, tx pgx.Tx) (map[string][]string, error) {
	names := make([]string, len(tables))
	for i, t := range tables {
		names[i] = t.name
	}
	rows, err := tx.Query(ctx, `
		SELECT table_name::text, column_name::text FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = ANY($1)`, names)
	if err != nil {
		return nil, err
	}
	out := map[string][]string{}
	var table, column string
	_, err = pgx.ForEachRow(rows, []any{&table, &column}, func() error {
		out[table] = append(out[table], column)
		return nil
	})
	return out, err
}
