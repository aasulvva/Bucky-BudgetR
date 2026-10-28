// Command server runs the Bucky BudgetR API.
//
// Usage:
//
//	server          start the HTTP server (default)
//	server serve    same as above
//	server migrate  apply database migrations and exit
//	server reset-password --user NAME
//	                give NAME a temporary password and make them an active
//	                admin, for when no admin can log in; prints the password
//	server healthcheck
//	                exit 0 if the running server is ready (GET /readyz), for
//	                container health checks; needs only API_HOST and API_PORT
//
// The production image calls the binary bucky-server.
// Configuration comes from environment variables; see internal/config.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
	_ "time/tzdata" // the cycle rule's time zones, also without zone files (distroless)

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/allocation"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/config"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cycles"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/logging"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/refill"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/web"
)

// version is set at build time (-ldflags "-X main.version=…").
var version = "dev"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := run(ctx, os.Args[1:], os.Getenv, os.Stdout, os.Stderr)
	stop()
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, getenv func(string) string, out, logOut io.Writer) error {
	cmd := "serve"
	if len(args) > 0 {
		cmd = args[0]
	}
	var username string
	switch cmd {
	case "healthcheck":
		return healthcheck(ctx, getenv)
	case "serve", "migrate":
	case "reset-password":
		fs := flag.NewFlagSet(cmd, flag.ContinueOnError)
		fs.SetOutput(logOut)
		fs.StringVar(&username, "user", "", "the user to recover")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		if username == "" {
			return errors.New("reset-password needs --user")
		}
	default:
		return fmt.Errorf("unknown command %q (want serve, migrate, reset-password or healthcheck)", cmd)
	}

	cfg, err := config.Load(getenv)
	if err != nil {
		return err
	}
	logger := logging.New(cfg, logOut)
	if cmd == "serve" {
		logger.InfoContext(ctx, "starting", slog.String("version", version), slog.String("env", string(cfg.Env)))
	}

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
	switch cmd {
	case "migrate":
		return nil
	case "reset-password":
		return resetPassword(ctx, pool, username, out)
	}

	if err := auth.EnsureInitialAdmin(ctx, pool, cfg.InitialAdminPassword, logger); err != nil {
		return err
	}
	authSvc := auth.NewService(pool, logger, auth.Options{
		IdleTimeout: cfg.SessionIdleTimeout,
		MaxAge:      cfg.SessionMaxAge,
	})
	go authSvc.CleanupLoop(ctx, time.Hour)

	// now is the business services' clock: the real one, or in development
	// the debug clock. Auth always keeps the real time.
	now, debugRoutes, err := setupDebug(ctx, cfg, pool, logger)
	if err != nil {
		return err
	}
	ledgerSvc := ledger.New(ledger.Options{AfterRecord: allocation.AfterRecord})
	refills := refill.NewService(pool, ledgerSvc, refill.Options{Now: now})
	cyclesSvc := cycles.NewService(pool, cycles.Options{Now: now, OnEnd: refills.OnEnd, OnStart: refills.OnStart})
	go cyclesSvc.PlanLoop(ctx, time.Hour, logger)
	handler, err := httpapi.NewHandler(logger, pool, httpapi.Options{
		Auth:           authSvc,
		Accounts:       accounts.NewService(pool, ledgerSvc, accounts.Options{Now: now}),
		Cycles:         cyclesSvc,
		Buckets:        buckets.NewService(pool, ledgerSvc, buckets.Options{Now: now, OnCreate: refills.OnCreate}),
		Transactions:   transactions.NewService(pool, ledgerSvc, transactions.Options{Now: now, Refills: refills}),
		Refills:        refills,
		Docs:           cfg.Env == config.EnvDevelopment,
		Web:            web.Handler(),
		TrustedProxies: cfg.TrustedProxies,
		Debug:          debugRoutes,
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

// healthcheck asks the server running alongside (same API_HOST and API_PORT)
// whether it is ready. The image has no curl, so its health check runs this.
func healthcheck(ctx context.Context, getenv func(string) string) error {
	host := getenv("API_HOST")
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	port := getenv("API_PORT")
	if port == "" {
		port = "8080"
	}
	return probe(ctx, "http://"+net.JoinHostPort(host, port)+"/readyz")
}

func probe(ctx context.Context, url string) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("not ready: %w", err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("not ready: %s", res.Status)
	}
	return nil
}

// resetPassword is the way back in when no admin can log in.
func resetPassword(ctx context.Context, pool *pgxpool.Pool, username string, out io.Writer) error {
	password, err := auth.RecoverAdmin(ctx, pool, username)
	if errors.Is(err, auth.ErrUserNotFound) {
		return fmt.Errorf("no user named %q", username)
	}
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(out, "%s is now an active admin. Temporary password: %s\nThey must change it when they log in.\n", username, password)
	return err
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
