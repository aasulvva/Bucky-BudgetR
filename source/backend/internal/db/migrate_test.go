package db_test

import (
	"log/slog"
	"testing"

	"github.com/jackc/pgx/v5/stdlib"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
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

// Migration 00024 (#201) turns saved graphs into saved modules and graph
// widgets into module widgets, and back.
func TestSavedModulesMigration(t *testing.T) {
	pool := testdb.New(t)
	ctx := t.Context()
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()
	p, err := db.NewProvider(sqlDB)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.DownTo(ctx, 23); err != nil {
		t.Fatal(err)
	}
	alice := authtest.NewUser(t, pool, "alice")
	bob := authtest.NewUser(t, pool, "bob")
	const before = `{"locale":"nb-NO","saved_graphs":[{"id":"g-2","name":"Food","graph":{"kind":"bar","metric":"spending","period":"last-3-months","resolution":"month","top":3}}],` +
		`"dashboard":{"widgets":[{"id":"w1","type":"graph","width":"full","graph":{"saved_graph_id":"g-2"}}]}}`
	const after = `{"locale":"nb-NO","saved_modules":[{"id":"g-2","name":"Food","period":"last-3-months","module":{"id":"m-1","type":"graph","graph":{"kind":"bar","metric":"spending","resolution":"month","top":3}}}],` +
		`"dashboard":{"widgets":[{"id":"w1","type":"module","width":"full","module":{"saved_module_id":"g-2"}}]}}`
	if _, err := pool.Exec(ctx, `UPDATE users SET preferences = $2 WHERE id = $1`, alice.ID, before); err != nil {
		t.Fatal(err)
	}
	is := func(id, want string) {
		t.Helper()
		var ok bool
		if err := pool.QueryRow(ctx, `SELECT preferences = $2::jsonb FROM users WHERE id = $1`, id, want).Scan(&ok); err != nil {
			t.Fatal(err)
		}
		if !ok {
			var got string
			_ = pool.QueryRow(ctx, `SELECT preferences::text FROM users WHERE id = $1`, id).Scan(&got)
			t.Errorf("user %s's preferences %s, want %s", id, got, want)
		}
	}

	if _, err := p.UpTo(ctx, 24); err != nil {
		t.Fatal(err)
	}
	is(alice.ID, after)
	is(bob.ID, `{}`)

	if _, err := p.DownTo(ctx, 23); err != nil {
		t.Fatal(err)
	}
	is(alice.ID, before)

	if _, err := p.Up(ctx); err != nil {
		t.Fatal(err)
	}
	is(alice.ID, after)
}
