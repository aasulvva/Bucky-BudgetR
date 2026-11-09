package db

import (
	"context"
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

// Migrations holds the embedded migration files. The goose CLI (`make migrate`)
// reads the same directory from disk.
var Migrations, _ = fs.Sub(embedded, "migrations")

// Migrate applies all pending migrations. A Postgres advisory lock makes it
// safe to run from several processes at once.
func Migrate(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) error {
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()

	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, Migrations, goose.WithSessionLocker(locker))
	if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}

	results, err := provider.Up(ctx)
	for _, r := range results {
		logger.InfoContext(ctx, "applied migration",
			slog.String(logging.EventKey, "migration.applied"),
			slog.Int64("version", r.Source.Version),
			slog.String("file", r.Source.Path),
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
