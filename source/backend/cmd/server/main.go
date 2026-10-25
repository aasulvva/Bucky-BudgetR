// Command server runs the Bucky BudgetR API.
//
// Usage:
//
//	server          start the HTTP server (default)
//	server serve    same as above
//	server migrate  apply database migrations and exit
//
// Configuration comes from environment variables; see internal/config.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/config"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cycles"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/logging"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := run(ctx, os.Args[1:], os.Getenv, os.Stderr)
	stop()
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, getenv func(string) string, logOut io.Writer) error {
	cmd := "serve"
	if len(args) > 0 {
		cmd = args[0]
	}
	if cmd != "serve" && cmd != "migrate" {
		return fmt.Errorf("unknown command %q (want serve or migrate)", cmd)
	}

	cfg, err := config.Load(getenv)
	if err != nil {
		return err
	}
	logger := logging.New(cfg, logOut)

	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	if cmd == "migrate" || cfg.MigrateOnStart {
		if err := db.Migrate(ctx, pool, logger); err != nil {
			return err
		}
	}
	if cmd == "migrate" {
		return nil
	}

	if err := auth.EnsureInitialAdmin(ctx, pool, cfg.InitialAdminPassword, logger); err != nil {
		return err
	}
	authSvc := auth.NewService(pool, logger, auth.Options{
		IdleTimeout: cfg.SessionIdleTimeout,
		MaxAge:      cfg.SessionMaxAge,
	})
	go authSvc.CleanupLoop(ctx, time.Hour)

	ledgerSvc := ledger.New(ledger.Options{})
	handler, err := httpapi.NewHandler(logger, pool, httpapi.Options{
		Auth:     authSvc,
		Accounts: accounts.NewService(pool, ledgerSvc, accounts.Options{}),
		Cycles:   cycles.NewService(pool, cycles.Options{}), // routines: #19
		Docs:     cfg.Env == config.EnvDevelopment,
	})
	if err != nil {
		return err
	}
	srv := &http.Server{
		Addr:              cfg.Addr(),
		Handler:           handler,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	return serve(ctx, srv, cfg.ShutdownTimeout, logger)
}

// serve runs srv until ctx is cancelled, then shuts it down gracefully,
// waiting up to timeout for in-flight requests.
func serve(ctx context.Context, srv *http.Server, timeout time.Duration, logger *slog.Logger) error {
	ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", srv.Addr)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	logger.InfoContext(ctx, "listening", slog.String("addr", ln.Addr().String()))

	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()

	select {
	case err := <-errc:
		return fmt.Errorf("serve: %w", err)
	case <-ctx.Done():
	}

	logger.Info("shutting down", slog.Duration("timeout", timeout))
	shutdownCtx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	if err := <-errc; !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve: %w", err)
	}
	logger.Info("stopped")
	return nil
}
