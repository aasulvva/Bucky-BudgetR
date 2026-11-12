package db

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/logging"
)

//go:embed migrations/*.sql
var embedded embed.FS

// Migrations holds the embedded SQL migration files. Migrations that need
// code are Go migrations (goMigrations), so `make migrate` runs the server's
// migrate command rather than the goose CLI, which can't see them.
var Migrations, _ = fs.Sub(embedded, "migrations")

// goMigrations are the migrations written in Go, in version order among the
// SQL files'.
var goMigrations = []*goose.Migration{
	goose.NewGoMigration(24,
		&goose.GoFunc{RunTx: savedModulesUp},
		&goose.GoFunc{RunTx: savedModulesDown}),
}

// GoMigrationVersions are the Go migrations' versions, which testdb counts
// in its template's hash.
func GoMigrationVersions() []int64 {
	out := make([]int64, len(goMigrations))
	for i, m := range goMigrations {
		out[i] = m.Version
	}
	return out
}

// NewProvider is goose's provider for the SQL and Go migrations.
func NewProvider(sqlDB *sql.DB, opts ...goose.ProviderOption) (*goose.Provider, error) {
	opts = append([]goose.ProviderOption{
		goose.WithGoMigrations(goMigrations...),
		goose.WithDisableGlobalRegistry(true),
	}, opts...)
	return goose.NewProvider(goose.DialectPostgres, sqlDB, Migrations, opts...)
}

// Migrate applies all pending migrations. A Postgres advisory lock makes it
// safe to run from several processes at once.
func Migrate(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) error {
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()

	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	provider, err := NewProvider(sqlDB, goose.WithSessionLocker(locker))
	if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}

	results, err := provider.Up(ctx)
	for _, r := range results {
		logger.InfoContext(ctx, "applied migration",
			slog.String(logging.EventKey, "migration.applied"),
			slog.Int64("version", r.Source.Version),
			slog.String("file", migrationName(r.Source)),
			slog.Duration("duration", r.Duration))
	}
	if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}

	version, err := provider.GetDBVersion(ctx)
	if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	logger.InfoContext(ctx, "database schema up to date", slog.Int64("version", version))
	return nil
}

// migrationName is a migration's file, or "go" for a Go migration, which
// has none.
func migrationName(s *goose.Source) string {
	if s.Path == "" {
		return "go"
	}
	return s.Path
}
