//go:build debug

package main

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/config"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/debug"
)

// setupDebug turns on the debug settings (#100) in development: the fake
// clock for the business services and the /api/dev/ routes. Only a binary
// built with -tags debug has this; see debug_off.go.
func setupDebug(ctx context.Context, cfg config.Config, pool *pgxpool.Pool, logger *slog.Logger) (func() time.Time, func(*http.ServeMux), error) {
	if cfg.Env != config.EnvDevelopment {
		logger.WarnContext(ctx, "built with the debug tag, but APP_ENV isn't development: debug settings are off")
		return time.Now, nil, nil
	}
	d, err := debug.Init(ctx, pool)
	if err != nil {
		return nil, nil, err
	}
	if s := d.Clock.State(); s.Mode != debug.Real {
		logger.WarnContext(ctx, "the debug clock is not on real time", slog.String("mode", string(s.Mode)), slog.Time("now", d.Clock.Now()))
	}
	return d.Clock.Now, d.Register(logger), nil
}
