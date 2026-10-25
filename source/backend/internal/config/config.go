// Package config loads the server configuration from environment variables.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"time"
)

// Env is the deployment environment. It picks defaults such as the log format.
type Env string

const (
	EnvDevelopment Env = "development"
	EnvProduction  Env = "production"
)

// Config holds the server settings. Use Load to build it.
type Config struct {
	Env             Env
	DatabaseURL     string
	Host            string
	Port            int
	LogLevel        slog.Level
	LogFormat       string // "text" or "json"
	MigrateOnStart  bool
	ShutdownTimeout time.Duration

	// SessionIdleTimeout ends a session that hasn't been used for this long;
	// SessionMaxAge ends every session this long after login.
	SessionIdleTimeout time.Duration
	SessionMaxAge      time.Duration
	// InitialAdminPassword overrides the spec's default password for the admin
	// account created on first start. Empty means the default.
	InitialAdminPassword string
}

// Addr is the listen address for the HTTP server.
func (c Config) Addr() string {
	return net.JoinHostPort(c.Host, strconv.Itoa(c.Port))
}

// Load reads the configuration through getenv (usually os.Getenv). Unset or
// empty variables get their defaults. Every invalid value is reported in the
// returned error, not just the first one.
func Load(getenv func(string) string) (Config, error) {
	var errs []error
	get := func(key, def string) string {
		if v := getenv(key); v != "" {
			return v
		}
		return def
	}

	cfg := Config{
		Env:                  Env(get("APP_ENV", string(EnvProduction))),
		DatabaseURL:          getenv("DATABASE_URL"),
		Host:                 getenv("API_HOST"),
		InitialAdminPassword: getenv("BUCKY_INITIAL_ADMIN_PASSWORD"),
	}

	if cfg.Env != EnvDevelopment && cfg.Env != EnvProduction {
		errs = append(errs, fmt.Errorf("APP_ENV: must be %q or %q, got %q", EnvDevelopment, EnvProduction, cfg.Env))
	}
	if cfg.DatabaseURL == "" {
		errs = append(errs, errors.New("DATABASE_URL: required"))
	}

	port, err := strconv.Atoi(get("API_PORT", "8080"))
	if err != nil || port < 1 || port > 65535 {
		errs = append(errs, fmt.Errorf("API_PORT: must be a port number, got %q", getenv("API_PORT")))
	}
	cfg.Port = port

	if err := cfg.LogLevel.UnmarshalText([]byte(get("LOG_LEVEL", "info"))); err != nil {
		errs = append(errs, fmt.Errorf("LOG_LEVEL: %w", err))
	}

	defaultFormat := "json"
	if cfg.Env == EnvDevelopment {
		defaultFormat = "text"
	}
	cfg.LogFormat = get("LOG_FORMAT", defaultFormat)
	if cfg.LogFormat != "text" && cfg.LogFormat != "json" {
		errs = append(errs, fmt.Errorf("LOG_FORMAT: must be \"text\" or \"json\", got %q", cfg.LogFormat))
	}

	cfg.MigrateOnStart, err = strconv.ParseBool(get("MIGRATE_ON_START", "true"))
	if err != nil {
		errs = append(errs, fmt.Errorf("MIGRATE_ON_START: must be a boolean, got %q", getenv("MIGRATE_ON_START")))
	}

	cfg.ShutdownTimeout, err = time.ParseDuration(get("SHUTDOWN_TIMEOUT", "10s"))
	if err != nil || cfg.ShutdownTimeout <= 0 {
		errs = append(errs, fmt.Errorf("SHUTDOWN_TIMEOUT: must be a positive duration such as 10s, got %q", getenv("SHUTDOWN_TIMEOUT")))
	}

	cfg.SessionIdleTimeout, err = time.ParseDuration(get("SESSION_IDLE_TIMEOUT", "168h"))
	if err != nil || cfg.SessionIdleTimeout <= 0 {
		errs = append(errs, fmt.Errorf("SESSION_IDLE_TIMEOUT: must be a positive duration such as 168h, got %q", getenv("SESSION_IDLE_TIMEOUT")))
	}
	cfg.SessionMaxAge, err = time.ParseDuration(get("SESSION_MAX_AGE", "720h"))
	if err != nil || cfg.SessionMaxAge <= 0 {
		errs = append(errs, fmt.Errorf("SESSION_MAX_AGE: must be a positive duration such as 720h, got %q", getenv("SESSION_MAX_AGE")))
	} else if cfg.SessionMaxAge < cfg.SessionIdleTimeout {
		errs = append(errs, errors.New("SESSION_MAX_AGE: must not be shorter than SESSION_IDLE_TIMEOUT"))
	}

	if len(errs) > 0 {
		return Config{}, fmt.Errorf("invalid configuration: %w", errors.Join(errs...))
	}
	return cfg, nil
}
