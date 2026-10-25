package config

import (
	"log/slog"
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load(env(map[string]string{"DATABASE_URL": "postgres://x"}))
	if err != nil {
		t.Fatal(err)
	}
	want := Config{
		Env:             EnvProduction,
		DatabaseURL:     "postgres://x",
		Port:            8080,
		LogLevel:        slog.LevelInfo,
		LogFormat:       "json",
		MigrateOnStart:  true,
		ShutdownTimeout: 10 * time.Second,
	}
	if cfg != want {
		t.Errorf("got %+v, want %+v", cfg, want)
	}
	if got := cfg.Addr(); got != ":8080" {
		t.Errorf("Addr() = %q, want %q", got, ":8080")
	}
}

func TestLoadDevelopment(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"DATABASE_URL":     "postgres://x",
		"APP_ENV":          "development",
		"API_HOST":         "127.0.0.1",
		"API_PORT":         "9000",
		"LOG_LEVEL":        "debug",
		"MIGRATE_ON_START": "false",
		"SHUTDOWN_TIMEOUT": "3s",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LogFormat != "text" {
		t.Errorf("LogFormat = %q, want text in development", cfg.LogFormat)
	}
	if cfg.LogLevel != slog.LevelDebug || cfg.MigrateOnStart || cfg.ShutdownTimeout != 3*time.Second {
		t.Errorf("unexpected config %+v", cfg)
	}
	if got := cfg.Addr(); got != "127.0.0.1:9000" {
		t.Errorf("Addr() = %q", got)
	}
}

func TestLoadReportsAllErrors(t *testing.T) {
	_, err := Load(env(map[string]string{
		"APP_ENV":          "staging",
		"API_PORT":         "70000",
		"LOG_LEVEL":        "loud",
		"LOG_FORMAT":       "xml",
		"MIGRATE_ON_START": "maybe",
		"SHUTDOWN_TIMEOUT": "-1s",
	}))
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, key := range []string{"APP_ENV", "DATABASE_URL", "API_PORT", "LOG_LEVEL", "LOG_FORMAT", "MIGRATE_ON_START", "SHUTDOWN_TIMEOUT"} {
		if !strings.Contains(err.Error(), key) {
			t.Errorf("error does not mention %s: %v", key, err)
		}
	}
}
