package pdf

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
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

// blankPDF is a PDF of n empty A4 pages.
func blankPDF(n int) []byte {
	var b bytes.Buffer
	var offsets []int
	obj := func(body string) {
		offsets = append(offsets, b.Len())
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", len(offsets), body)
	}
	b.WriteString("%PDF-1.7\n")
	obj("<< /Type /Catalog /Pages 2 0 R >>")
	kids := make([]string, n)
	for i := range n {
		kids[i] = fmt.Sprintf("%d 0 R", i+3)
	}
	obj(fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), n))
	for range n {
		obj("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>")
	}
	xref := b.Len()
	fmt.Fprintf(&b, "xref\n0 %d\n0000000000 65535 f \n", len(offsets)+1)
	for _, o := range offsets {
		fmt.Fprintf(&b, "%010d 00000 n \n", o)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets)+1, xref)
	return b.Bytes()
}

func TestOutline(t *testing.T) {
	ctx := context.Background()
	// As Chrome makes it: the report's name, its modules, a module's sections.
	bms := []pdfcpu.Bookmark{{Title: "Året", PageFrom: 1, Kids: []pdfcpu.Bookmark{
		{Title: "Spending", PageFrom: 2},
		{Title: "Transactions", PageFrom: 3, Kids: []pdfcpu.Bookmark{
			{Title: "March 2025", PageFrom: 3},
			{Title: "February 2025", PageFrom: 4},
		}},
	}}}
	var out bytes.Buffer
	if err := api.AddBookmarks(ctx, bytes.NewReader(blankPDF(4)), &out, bms, true, model.NewStatelessConfiguration()); err != nil {
		t.Fatal(err)
	}
	marks, err := outline(ctx, out.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	want := []Mark{{"Året", 1}, {"Spending", 2}, {"Transactions", 3}, {"March 2025", 3}, {"February 2025", 4}}
	if !slices.Equal(marks, want) {
		t.Errorf("outline = %v, want %v", marks, want)
	}
	// A PDF without an outline has no marks, or says so.
	if marks, err := outline(ctx, blankPDF(1)); err == nil && len(marks) > 0 {
		t.Errorf("outline of a PDF without one = %v", marks)
	}
}
