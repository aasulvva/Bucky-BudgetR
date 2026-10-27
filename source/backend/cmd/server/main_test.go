package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestHealthcheck(t *testing.T) {
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/readyz" {
			t.Errorf("asked for %s", r.URL.Path)
		}
		w.WriteHeader(status)
	}))
	defer srv.Close()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"API_HOST": "0.0.0.0", "API_PORT": u.Port()}
	getenv := func(k string) string { return env[k] }

	if err := run(t.Context(), []string{"healthcheck"}, getenv, io.Discard, io.Discard); err != nil {
		t.Errorf("ready: %v", err)
	}
	status = http.StatusServiceUnavailable
	if err := run(t.Context(), []string{"healthcheck"}, getenv, io.Discard, io.Discard); err == nil || !strings.Contains(err.Error(), "503") {
		t.Errorf("not ready: %v", err)
	}
	srv.Close()
	if err := run(t.Context(), []string{"healthcheck"}, getenv, io.Discard, io.Discard); err == nil {
		t.Error("down: want an error")
	}
}

func TestUnknownCommand(t *testing.T) {
	err := run(t.Context(), []string{"fly"}, func(string) string { return "" }, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "healthcheck") {
		t.Errorf("got %v", err)
	}
}
