package db

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/preferences"
)

// Migration 00024 (#201): saved graphs become saved modules, and graph
// widgets module widgets, in every user's preferences. The way back keeps
// the saved graph modules as saved graphs and drops the rest.

func savedModulesUp(ctx context.Context, tx *sql.Tx) error {
	return convertPreferences(ctx, tx, preferences.SavedModulesUp)
}

func savedModulesDown(ctx context.Context, tx *sql.Tx) error {
	return convertPreferences(ctx, tx, preferences.SavedModulesDown)
}

// convertPreferences converts each user's preferences with conv, writing
// only those that change. It isn't an edit by the user, so modified_at
// stays.
func convertPreferences(ctx context.Context, tx *sql.Tx, conv func(map[string]any) bool) error {
	rows, err := tx.QueryContext(ctx, `SELECT id, preferences FROM users ORDER BY id FOR UPDATE`)
	if err != nil {
		return fmt.Errorf("read preferences: %w", err)
	}
	type row struct {
		id    string
		prefs []byte
	}
	var changed []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.prefs); err != nil {
			_ = rows.Close()
			return fmt.Errorf("read preferences: %w", err)
		}
		out, ok, err := preferences.ConvertJSON(r.prefs, conv)
		if err != nil {
			_ = rows.Close()
			return fmt.Errorf("user %s: %w", r.id, err)
		}
		if ok {
			changed = append(changed, row{r.id, out})
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return fmt.Errorf("read preferences: %w", err)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, r := range changed {
		if _, err := tx.ExecContext(ctx, `UPDATE users SET preferences = $2 WHERE id = $1`, r.id, r.prefs); err != nil {
			return fmt.Errorf("user %s: %w", r.id, err)
		}
	}
	return nil
}
