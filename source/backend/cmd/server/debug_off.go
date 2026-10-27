//go:build !debug

package main

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/config"
)

// setupDebug: without the debug tag (production builds), there are no debug
// settings and the clock is the real one. See debug_on.go.
func setupDebug(context.Context, config.Config, *pgxpool.Pool, *slog.Logger) (func() time.Time, func(*http.ServeMux), error) {
	return time.Now, nil, nil
}
