package httpapi_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/pdf"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

// fakePDF is a renderer that calls during, while the render token is valid,
// and returns out or err.
type fakePDF struct {
	jobs   []pdf.Job
	during func(job pdf.Job)
	out    []byte
	err    error
}

func (f *fakePDF) Render(_ context.Context, job pdf.Job) ([]byte, error) {
	f.jobs = append(f.jobs, job)
	if f.during != nil {
		f.during(job)
	}
	return f.out, f.err
}

func setupPDF(t *testing.T, r pdf.Renderer) env {
	t.Helper()
	pool := testdb.New(t)
	c := &clock{now: time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)}
	svc := auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge, Now: c.Now})
	return env{h: newHandler(t, discard(), pool, httpapi.Options{Auth: svc, PDF: r}), pool: pool, clock: c}
}

// asRender sends a request as the headless Chrome does: with the render
// token and no cookie.
func asRender(e env, job pdf.Job, method, path string) *httptest.ResponseRecorder {
	r := httptest.NewRequestWithContext(context.Background(), method, path, nil)
	r.Header.Set(job.Header, job.Token)
	if method != http.MethodGet && method != http.MethodHead {
		r.Header.Set("X-Bucky-CSRF", "1")
	}
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, r)
	return w
}

func pdfBody(name, timeZone string) map[string]any {
	return map[string]any{
		"name": name,
		"report": map[string]any{
			"period": "previous-year",
			"modules": []map[string]any{
				{"id": "m-1", "type": "graph", "graph": map[string]any{"kind": "bar", "metric": "spending", "resolution": "month"}},
			},
		},
		"language":  "nb",
		"locale":    "nb-NO",
		"time_zone": timeZone,
	}
}

func TestExportReportPdf(t *testing.T) {
	f := &fakePDF{out: []byte("%PDF-1.7 fake")}
	e := setupPDF(t, f)
	user := authtest.NewUser(t, e.pool, "alice", authtest.Admin)
	other := authtest.NewUser(t, e.pool, "bob")
	cookie := authtest.Login(t, e.h, "alice")

	f.during = func(job pdf.Job) {
		if w := asRender(e, job, http.MethodGet, "/api/v1/me"); w.Code != http.StatusOK || decodeUser(t, w).Id != user.ID {
			t.Errorf("GET /me as the render: %d %s", w.Code, w.Body)
		}
		// Only reads, and never as an admin.
		if w := asRender(e, job, http.MethodPost, "/api/v1/auth/logout"); w.Code != http.StatusForbidden || deref(decodeProblem(t, w).Code) != "read_only" {
			t.Errorf("POST as the render: %d %s", w.Code, w.Body)
		}
		if w := asRender(e, job, http.MethodGet, "/api/v1/admin/users"); w.Code != http.StatusForbidden {
			t.Errorf("admin route as the render: %d %s", w.Code, w.Body)
		}
	}
	w := authtest.Do(t, e.h, http.MethodPost, "/api/v1/reports/pdf", pdfBody(` Year: "2025"/all `, "Europe/Oslo"), cookie)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	if got := w.Body.String(); got != "%PDF-1.7 fake" {
		t.Errorf("body %q", got)
	}
	if got := w.Header().Get("Content-Type"); got != "application/pdf" {
		t.Errorf("Content-Type %q", got)
	}
	if got := w.Header().Get("Content-Disposition"); got != `attachment; filename="Year- -2025--all.pdf"` {
		t.Errorf("Content-Disposition %q", got)
	}

	if len(f.jobs) != 1 {
		t.Fatalf("%d renders", len(f.jobs))
	}
	job := f.jobs[0]
	if job.Header != httpapi.RenderHeader || len(job.Token) < 40 || job.Page != httpapi.PrintPage ||
		job.TimeZone != "Europe/Oslo" || job.Locale != "nb-NO" {
		t.Errorf("job %+v", job)
	}
	// The page's data, as it reads it from the fragment.
	raw, err := json.Marshal(job.Data)
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		Name        string    `json:"name"`
		Language    string    `json:"language"`
		Locale      string    `json:"locale"`
		TimeZone    string    `json:"time_zone"`
		GeneratedAt time.Time `json:"generated_at"`
		Report      struct {
			Period  string `json:"period"`
			Modules []struct {
				ID string `json:"id"`
			} `json:"modules"`
		} `json:"report"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatal(err)
	}
	if data.Name != `Year: "2025"/all` || data.Language != "nb" || data.Locale != "nb-NO" || data.TimeZone != "Europe/Oslo" ||
		data.Report.Period != "previous-year" || len(data.Report.Modules) != 1 || data.GeneratedAt.IsZero() {
		t.Errorf("data %s", raw)
	}

	// The render's over: its token no longer works.
	if w := asRender(e, job, http.MethodGet, "/api/v1/me"); w.Code != http.StatusUnauthorized {
		t.Errorf("GET /me after the render: %d", w.Code)
	}

	// Another user's export reads as that user.
	f.during = func(job pdf.Job) {
		if w := asRender(e, job, http.MethodGet, "/api/v1/me"); decodeUser(t, w).Id != other.ID {
			t.Errorf("render of bob reads as %s", w.Body)
		}
	}
	if w := authtest.Do(t, e.h, http.MethodPost, "/api/v1/reports/pdf", pdfBody("Q3", "UTC"), authtest.Login(t, e.h, "bob")); w.Code != http.StatusOK {
		t.Errorf("bob: %d %s", w.Code, w.Body)
	}
}

func TestExportReportPdfRenderToken(t *testing.T) {
	f := &fakePDF{out: []byte("%PDF")}
	e := setupPDF(t, f)
	user := authtest.NewUser(t, e.pool, "alice")
	cookie := authtest.Login(t, e.h, "alice")

	// A token expires after RenderTTL, even while the render runs.
	f.during = func(job pdf.Job) {
		e.clock.Advance(auth.RenderTTL - time.Second)
		if w := asRender(e, job, http.MethodGet, "/api/v1/me"); w.Code != http.StatusOK {
			t.Errorf("before expiry: %d", w.Code)
		}
		e.clock.Advance(time.Second)
		if w := asRender(e, job, http.MethodGet, "/api/v1/me"); w.Code != http.StatusUnauthorized {
			t.Errorf("after expiry: %d", w.Code)
		}
	}
	authtest.Do(t, e.h, http.MethodPost, "/api/v1/reports/pdf", pdfBody("A", "UTC"), cookie)

	// A user who's deactivated mid-render loses it.
	cookie = authtest.Login(t, e.h, "alice")
	f.during = func(job pdf.Job) {
		authtest.Deactivate(t, e.pool, user.ID)
		if w := asRender(e, job, http.MethodGet, "/api/v1/me"); w.Code != http.StatusUnauthorized {
			t.Errorf("inactive: %d", w.Code)
		}
	}
	authtest.Do(t, e.h, http.MethodPost, "/api/v1/reports/pdf", pdfBody("A", "UTC"), cookie)

	// A made-up token is no session.
	if w := asRender(e, pdf.Job{Header: httpapi.RenderHeader, Token: "nope"}, http.MethodGet, "/api/v1/me"); w.Code != http.StatusUnauthorized {
		t.Errorf("unknown token: %d", w.Code)
	}
}

func TestExportReportPdfErrors(t *testing.T) {
	post := func(e env, body any) *httptest.ResponseRecorder {
		authtest.NewUser(t, e.pool, "alice")
		return authtest.Do(t, e.h, http.MethodPost, "/api/v1/reports/pdf", body, authtest.Login(t, e.h, "alice"))
	}
	problem := func(name string, w *httptest.ResponseRecorder, status int, code string) {
		t.Helper()
		if w.Code != status || deref(decodeProblem(t, w).Code) != code {
			t.Errorf("%s: got %d %s, want %d %s", name, w.Code, w.Body, status, code)
		}
	}

	// Not set up.
	problem("unconfigured", post(setupPDF(t, nil), pdfBody("A", "UTC")), http.StatusServiceUnavailable, "pdf_unavailable")

	f := &fakePDF{}
	e := setupPDF(t, f)
	authtest.NewUser(t, e.pool, "alice")
	cookie := authtest.Login(t, e.h, "alice")
	send := func(body any) *httptest.ResponseRecorder {
		return authtest.Do(t, e.h, http.MethodPost, "/api/v1/reports/pdf", body, cookie)
	}
	problem("bad time zone", send(pdfBody("A", "Mars/Olympus")), http.StatusBadRequest, "invalid_request")
	problem("Local", send(pdfBody("A", "Local")), http.StatusBadRequest, "invalid_request")
	problem("blank name", send(pdfBody("  ", "UTC")), http.StatusBadRequest, "invalid_request")
	bad := pdfBody("A", "UTC")
	bad["locale"] = "nb_NO"
	problem("bad locale", send(bad), http.StatusBadRequest, "invalid_request")
	bad = pdfBody("A", "UTC")
	bad["report"].(map[string]any)["modules"] = []map[string]any{{"id": "m", "type": "graph"}}
	problem("module without settings", send(bad), http.StatusBadRequest, "invalid_request")
	if len(f.jobs) != 0 {
		t.Errorf("bad requests rendered %d times", len(f.jobs))
	}

	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{pdf.ErrBusy, http.StatusTooManyRequests, "too_many_renders"},
		{pdf.ErrUnavailable, http.StatusServiceUnavailable, "pdf_unavailable"},
		{errors.Join(pdf.ErrFailed, io.EOF), http.StatusBadGateway, "pdf_failed"},
	} {
		f.err = tc.err
		problem(tc.code, send(pdfBody("A", "UTC")), tc.status, tc.code)
	}

	// No session.
	if w := authtest.Do(t, e.h, http.MethodPost, "/api/v1/reports/pdf", pdfBody("A", "UTC"), nil); w.Code != http.StatusUnauthorized {
		t.Errorf("no session: %d", w.Code)
	}
}
