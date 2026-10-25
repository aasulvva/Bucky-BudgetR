// Package logging builds the application's slog logger.
package logging

import (
	"io"
	"log/slog"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/config"
)

// New returns a logger writing to w in the configured format and level.
func New(cfg config.Config, w io.Writer) *slog.Logger {
	opts := &slog.HandlerOptions{Level: cfg.LogLevel}
	if cfg.LogFormat == "text" {
		return slog.New(slog.NewTextHandler(w, opts))
	}
	return slog.New(slog.NewJSONHandler(w, opts))
}
