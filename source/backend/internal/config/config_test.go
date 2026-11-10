package config

import (
	"log/slog"
	"net/netip"
	"reflect"
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
		Env:                EnvProduction,
		DatabaseURL:        "postgres://x",
		Port:               8080,
		LogLevel:           slog.LevelInfo,
		LogFormat:          "json",
		MigrateOnStart:     true,
		ShutdownTimeout:    10 * time.Second,
		SessionIdleTimeout: 7 * 24 * time.Hour,
		SessionMaxAge:      30 * 24 * time.Hour,
		ScheduleInterval:   30 * time.Second,
	}
	if !reflect.DeepEqual(cfg, want) {
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
		"APP_ENV":              "staging",
		"API_PORT":             "70000",
		"LOG_LEVEL":            "loud",
		"LOG_FORMAT":           "xml",
		"MIGRATE_ON_START":     "maybe",
		"SHUTDOWN_TIMEOUT":     "-1s",
		"SESSION_IDLE_TIMEOUT": "soon",
		"SESSION_MAX_AGE":      "0s",
		"SCHEDULE_INTERVAL":    "10ms",
		"TRUSTED_PROXIES":      "10.0.0.0/8, proxy",
	}))
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, key := range []string{"APP_ENV", "DATABASE_URL", "API_PORT", "LOG_LEVEL", "LOG_FORMAT", "MIGRATE_ON_START", "SHUTDOWN_TIMEOUT", "SESSION_IDLE_TIMEOUT", "SESSION_MAX_AGE", "SCHEDULE_INTERVAL", "TRUSTED_PROXIES"} {
		if !strings.Contains(err.Error(), key) {
			t.Errorf("error does not mention %s: %v", key, err)
		}
	}
}

func TestLoadSessionMaxAgeAtLeastIdle(t *testing.T) {
	_, err := Load(env(map[string]string{
		"DATABASE_URL":         "postgres://x",
		"SESSION_IDLE_TIMEOUT": "48h",
		"SESSION_MAX_AGE":      "24h",
	}))
	if err == nil || !strings.Contains(err.Error(), "must not be shorter") {
		t.Fatalf("err = %v", err)
	}
}

func TestLoadTrustedProxies(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"DATABASE_URL":    "postgres://x",
		"TRUSTED_PROXIES": " 172.30.0.0/24, 10.1.2.3 ,, ::1, 192.168.1.77/24",
	}))
	if err != nil {
		t.Fatal(err)
	}
	want := []netip.Prefix{
		netip.MustParsePrefix("172.30.0.0/24"),
		netip.MustParsePrefix("10.1.2.3/32"),
		netip.MustParsePrefix("::1/128"),
		netip.MustParsePrefix("192.168.1.0/24"),
	}
	if !reflect.DeepEqual(cfg.TrustedProxies, want) {
		t.Errorf("got %v, want %v", cfg.TrustedProxies, want)
	}
}

func TestLoadPDF(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"DATABASE_URL":   "postgres://x",
		"PDF_CHROME_URL": "http://chrome:9222/",
		"PDF_APP_URL":    "http://app:8080",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PDFChromeURL != "http://chrome:9222" || cfg.PDFAppURL != "http://app:8080" {
		t.Errorf("got %q and %q", cfg.PDFChromeURL, cfg.PDFAppURL)
	}

	for name, vars := range map[string]map[string]string{
		"only one":  {"PDF_CHROME_URL": "http://chrome:9222"},
		"a path":    {"PDF_CHROME_URL": "http://chrome:9222", "PDF_APP_URL": "http://app:8080/app"},
		"no scheme": {"PDF_CHROME_URL": "chrome:9222", "PDF_APP_URL": "http://app:8080"},
		"ws":        {"PDF_CHROME_URL": "ws://chrome:9222", "PDF_APP_URL": "http://app:8080"},
	} {
		vars["DATABASE_URL"] = "postgres://x"
		if _, err := Load(env(vars)); err == nil || !strings.Contains(err.Error(), "PDF_") {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}
