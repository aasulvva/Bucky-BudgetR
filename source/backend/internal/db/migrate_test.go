package db_test

import (
	"log/slog"
	"testing"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

func TestMigrateIsIdempotent(t *testing.T) {
	pool := testdb.New(t)
	logger := slog.New(slog.DiscardHandler)

	// The template is already migrated, so this must be a no-op, as on every
	// restart of the server.
	if err := db.Migrate(t.Context(), pool, logger); err != nil {
		t.Fatal(err)
	}

	var version int64
	if err := pool.QueryRow(t.Context(), "SELECT max(version_id) FROM goose_db_version").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version < 1 {
		t.Errorf("schema version %d, want at least 1", version)
	}
}
