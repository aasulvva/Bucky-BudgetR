package httpapi

import (
	"bytes"
	"context"
	"errors"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/pdf"
)

// PrintPage is the frontend's page that a report PDF prints (#127).
const PrintPage = "/print/report"

// printJob is what the print page reads from its URL's fragment: the
// request, and when the PDF was made.
type printJob struct {
	Name        string             `json:"name"`
	Report      api.ReportSettings `json:"report"`
	Language    string             `json:"language"`
	Locale      string             `json:"locale"`
	TimeZone    string             `json:"time_zone"`
	GeneratedAt time.Time          `json:"generated_at"`
}

func (s *server) ExportReportPdf(ctx context.Context, req api.ExportReportPdfRequestObject) (api.ExportReportPdfResponseObject, error) {
	if s.pdf == nil || s.auth == nil {
		return nil, &Error{Status: http.StatusServiceUnavailable, Code: "pdf_unavailable", Detail: "PDF export isn't set up on this server."}
	}
	sess := sessionFrom(ctx)
	b := req.Body
	bad := func(detail string) error {
		return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: detail}
	}
	if strings.TrimSpace(b.Name) == "" {
		return nil, bad("The report needs a name.")
	}
	if err := checkReportModules("The report", b.Report); err != nil {
		return nil, err
	}
	if _, err := time.LoadLocation(b.TimeZone); err != nil || b.TimeZone == "Local" {
		return nil, bad("Unknown time zone " + b.TimeZone + ".")
	}

	token, end := s.auth.StartRender(sess.User.ID)
	defer end()
	out, err := s.pdf.Render(ctx, pdf.Job{
		Header: RenderHeader,
		Token:  token,
		Page:   PrintPage,
		Data: printJob{
			Name: strings.TrimSpace(b.Name), Report: b.Report, Language: string(b.Language),
			Locale: b.Locale, TimeZone: b.TimeZone, GeneratedAt: time.Now().UTC(),
		},
		TimeZone: b.TimeZone,
		Locale:   b.Locale,
	})
	switch {
	case errors.Is(err, pdf.ErrBusy):
		return nil, &Error{Status: http.StatusTooManyRequests, Code: "too_many_renders", Detail: "Other PDFs are being made. Try again in a moment.", Err: err}
	case errors.Is(err, pdf.ErrUnavailable):
		return nil, &Error{Status: http.StatusServiceUnavailable, Code: "pdf_unavailable", Detail: "The PDF renderer can't be reached.", Err: err}
	case errors.Is(err, pdf.ErrFailed):
		return nil, &Error{Status: http.StatusBadGateway, Code: "pdf_failed", Detail: "The report couldn't be rendered.", Err: err}
	case err != nil:
		return nil, err
	}
	disposition := mime.FormatMediaType("attachment", map[string]string{"filename": pdfFileName(b.Name)})
	return api.ExportReportPdf200ApplicationpdfResponse{
		Body:          bytes.NewReader(out),
		ContentLength: int64(len(out)),
		Headers:       api.ExportReportPdf200ResponseHeaders{ContentDisposition: &disposition},
	}, nil
}

// pdfFileName is the report's name as a file name: without the characters
// file systems refuse, and .pdf.
func pdfFileName(name string) string {
	clean := strings.Map(func(r rune) rune {
		if r < 0x20 || strings.ContainsRune(`/\:*?"<>|`, r) {
			return '-'
		}
		return r
	}, strings.TrimSpace(name))
	if clean == "" {
		clean = "report"
	}
	return clean + ".pdf"
}

// longWrites gives the PDF export longer than the server's write timeout:
// Chrome has pdf.Timeout to render the page.
func longWrites(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/reports/pdf" {
			_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(pdf.Timeout + 30*time.Second))
		}
		next.ServeHTTP(w, r)
	})
}
