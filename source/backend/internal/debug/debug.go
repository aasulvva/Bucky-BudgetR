package debug

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Debug is the debug settings: the clock and the snapshots.
type Debug struct {
	pool  *pgxpool.Pool
	Clock *Clock
}

// schema creates the debug tables. They're not in the migrations, so
// production databases never get them.
const schema = `
CREATE TABLE IF NOT EXISTS debug_clock (
    id        boolean PRIMARY KEY DEFAULT true CHECK (id),
    mode      text NOT NULL,
    offset_us bigint NOT NULL DEFAULT 0,
    frozen_at timestamptz
);
CREATE TABLE IF NOT EXISTS debug_snapshots (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Not a foreign key: an imported snapshot can come from another database.
    user_id        text NOT NULL,
    name           text NOT NULL,
    taken_at       timestamptz NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    schema_version bigint NOT NULL,
    data           jsonb NOT NULL
);`

// Init creates the debug tables if needed and loads the clock's setting.
func Init(ctx context.Context, pool *pgxpool.Pool) (*Debug, error) {
	return initWith(ctx, pool, time.Now)
}

func initWith(ctx context.Context, pool *pgxpool.Pool, real func() time.Time) (*Debug, error) {
	if _, err := pool.Exec(ctx, schema); err != nil {
		return nil, fmt.Errorf("debug tables: %w", err)
	}
	c := newClock(pool, real)
	if err := c.load(ctx); err != nil {
		return nil, err
	}
	return &Debug{pool: pool, Clock: c}, nil
}
