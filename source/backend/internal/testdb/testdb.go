// Package testdb gives tests their own freshly migrated PostgreSQL database.
//
// It needs a server to connect to, taken from TEST_DATABASE_URL or else
// DATABASE_URL (the Makefile exports the dev database's URL). The role must be
// allowed to create databases. Without a URL, tests that use New are skipped,
// unless CI is set, in which case they fail.
//
// The migrations are applied once to a template database named after a hash of
// the migration files. Each test then gets a cheap copy of that template, which
// is dropped when the test ends, so tests can commit freely and run in parallel.
package testdb

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db"
)

const (
	templatePrefix = "bucky_test_tmpl_"
	testPrefix     = "bucky_test_"
	// lockKey serialises template setup between test binaries, since
	// `go test ./...` runs packages in parallel.
	lockKey = 0x6275636b79 // "bucky"
)

var (
	setupOnce    sync.Once
	templateName string
	setupErr     error
)

// New creates a database for this test from the migrated template and returns
// a pool connected to it. The pool is closed and the database dropped when the
// test ends.
func New(t testing.TB) *pgxpool.Pool {
	t.Helper()

	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = os.Getenv("DATABASE_URL")
	}
	if url == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("testdb: TEST_DATABASE_URL or DATABASE_URL must be set in CI")
		}
		t.Skip("testdb: no TEST_DATABASE_URL or DATABASE_URL; run `make db-up` and use `make test`")
	}

	setupOnce.Do(func() { templateName, setupErr = setupTemplate(context.Background(), url) })
	if setupErr != nil {
		t.Fatalf("testdb: prepare template: %v", setupErr)
	}

	name := testPrefix + strings.ToLower(rand.Text())
	if err := exec(t.Context(), url, fmt.Sprintf("CREATE DATABASE %s TEMPLATE %s", ident(name), ident(templateName))); err != nil {
		t.Fatalf("testdb: create database: %v", err)
	}
	pool, err := connectPool(t.Context(), url, name)
	if err != nil {
		t.Fatalf("testdb: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		if err := exec(context.Background(), url, fmt.Sprintf("DROP DATABASE %s WITH (FORCE)", ident(name))); err != nil {
			t.Errorf("testdb: drop database %s: %v", name, err)
		}
	})
	return pool
}

// setupTemplate makes sure an up-to-date template database exists and returns
// its name. Templates built from older migrations are dropped.
func setupTemplate(ctx context.Context, url string) (string, error) {
	hash, err := migrationsHash()
	if err != nil {
		return "", err
	}
	name := templatePrefix + hash
	building := name + "_building"

	conn, err := connect(ctx, url)
	if err != nil {
		return "", err
	}
	defer conn.Close(context.Background())

	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", lockKey); err != nil {
		return "", fmt.Errorf("lock: %w", err)
	}
	defer conn.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", lockKey) //nolint:errcheck // released with the session anyway

	var exists bool
	if err := conn.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)", name).Scan(&exists); err != nil {
		return "", err
	}
	if exists {
		return name, nil
	}

	// Drop old templates and leftovers from an interrupted build.
	rows, err := conn.Query(ctx, "SELECT datname FROM pg_database WHERE datname LIKE $1", templatePrefix+"%")
	if err != nil {
		return "", err
	}
	stale, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return "", err
	}
	for _, old := range stale {
		if _, err := conn.Exec(ctx, fmt.Sprintf("ALTER DATABASE %s IS_TEMPLATE false", ident(old))); err != nil {
			return "", err
		}
		if _, err := conn.Exec(ctx, fmt.Sprintf("DROP DATABASE %s WITH (FORCE)", ident(old))); err != nil {
			return "", err
		}
	}

	// Build under a temporary name and rename at the end, so a half-migrated
	// database is never mistaken for a finished template.
	if _, err := conn.Exec(ctx, "CREATE DATABASE "+ident(building)); err != nil {
		return "", err
	}
	pool, err := connectPool(ctx, url, building)
	if err != nil {
		return "", err
	}
	err = db.Migrate(ctx, pool, slog.New(slog.DiscardHandler))
	pool.Close()
	if err != nil {
		return "", err
	}
	if _, err := conn.Exec(ctx, fmt.Sprintf("ALTER DATABASE %s RENAME TO %s", ident(building), ident(name))); err != nil {
		return "", err
	}
	if _, err := conn.Exec(ctx, fmt.Sprintf("ALTER DATABASE %s WITH IS_TEMPLATE true ALLOW_CONNECTIONS false", ident(name))); err != nil {
		return "", err
	}
	return name, nil
}

// migrationsHash identifies the current set of migrations.
func migrationsHash() (string, error) {
	h := sha256.New()
	err := fs.WalkDir(db.Migrations, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := fs.ReadFile(db.Migrations, path)
		if err != nil {
			return err
		}
		fmt.Fprintf(h, "%s\x00%d\x00", path, len(b))
		h.Write(b)
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("hash migrations: %w", err)
	}
	// The Go migrations (#201) count by version: none of them changes an
	// empty template's schema.
	for _, v := range db.GoMigrationVersions() {
		fmt.Fprintf(h, "go\x00%d\x00", v)
	}
	return hex.EncodeToString(h.Sum(nil))[:16], nil
}

func connect(ctx context.Context, url string) (*pgx.Conn, error) {
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	return conn, nil
}

// connectPool opens a pool to database name on the server that url points at.
func connectPool(ctx context.Context, url, name string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.ConnConfig.Database = name
	db.Configure(cfg)
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect to %s: %w", name, err)
	}
	return pool, nil
}

// exec runs a single statement on its own short-lived connection.
func exec(ctx context.Context, url, sql string) error {
	conn, err := connect(ctx, url)
	if err != nil {
		return err
	}
	_, err = conn.Exec(ctx, sql)
	return errors.Join(err, conn.Close(context.Background()))
}

func ident(name string) string { return pgx.Identifier{name}.Sanitize() }
