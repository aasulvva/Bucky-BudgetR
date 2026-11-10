package pdf

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDevtoolsURL(t *testing.T) {
	for in, want := range map[string]string{
		"http://localhost:9222": "http://localhost:9222",
		"http://127.0.0.1:9222": "http://127.0.0.1:9222",
		"http://[::1]:9222":     "http://[::1]:9222",
	} {
		got, err := devtoolsURL(context.Background(), in)
		if err != nil || got != want {
			t.Errorf("%s: got %q, %v", in, got, err)
		}
	}
	if _, err := devtoolsURL(context.Background(), "http://no-such-host.invalid:9222"); err == nil {
		t.Error("an unknown host resolved")
	}
}

func TestRenderUnavailable(t *testing.T) {
	// Not a Chrome: it has no DevTools.
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	c := NewChrome(srv.URL, "http://app:8080")
	if _, err := c.Render(context.Background(), Job{Page: "/print/report"}); !errors.Is(err, ErrUnavailable) {
		t.Errorf("err = %v", err)
	}
}

func TestRenderBusy(t *testing.T) {
	c := NewChrome("http://127.0.0.1:1", "http://app:8080")
	c.slots <- struct{}{}
	c.slots <- struct{}{}
	if _, err := c.Render(context.Background(), Job{}); !errors.Is(err, ErrBusy) {
		t.Errorf("err = %v", err)
	}
}
