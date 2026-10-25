// Package db opens the PostgreSQL connection pool and applies the embedded
// schema migrations.
package db

import (
	"context"
	"fmt"

	pgxdecimal "github.com/jackc/pgx-shopspring-decimal"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Open creates a connection pool for url and checks that the database answers.
func Open(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	Configure(cfg)
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connect to database: %w", err)
	}
	return pool, nil
}

// Configure sets up every pool the same way:
//   - sessions use the UTC time zone, so now() and timestamps read as text are
//     UTC whatever the server's setting;
//   - numeric columns map to shopspring/decimal, so money never passes
//     through float64.
func Configure(cfg *pgxpool.Config) {
	cfg.ConnConfig.RuntimeParams["timezone"] = "UTC"
	afterConnect := cfg.AfterConnect
	cfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		pgxdecimal.Register(conn.TypeMap())
		if afterConnect != nil {
			return afterConnect(ctx, conn)
		}
		return nil
	}
}
