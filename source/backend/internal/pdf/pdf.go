// Package pdf renders report PDFs (#127) with a headless Chrome that the
// server drives over the DevTools protocol (chromedp). Chrome loads the
// app's print page itself, with a render token in a header and the asking
// browser's time zone and locale emulated, waits until the page says it's
// ready and prints it to A4.
package pdf

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/chromedp/cdproto/emulation"
	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/chromedp"
	"github.com/chromedp/chromedp/remote"
)

var (
	// ErrUnavailable means Chrome can't be reached.
	ErrUnavailable = errors.New("pdf: the renderer is unavailable")
	// ErrFailed means the page reported an error or wasn't ready in time.
	ErrFailed = errors.New("pdf: the page failed to render")
	// ErrBusy means too many renders are running.
	ErrBusy = errors.New("pdf: too many renders at once")
)

// Job is one PDF to render.
type Job struct {
	// Header is the request header Chrome sends with every request, with
	// the render token: the page's session.
	Header, Token string
	// Page is the app's page to print, from its root (e.g. /print/report),
	// and Data what goes, as JSON, base64url, in its fragment: never sent
	// to the server, so never in a log.
	Page string
	Data any
	// TimeZone (IANA) and Locale (BCP 47) are emulated in Chrome.
	TimeZone, Locale string
}

// Renderer renders a Job to PDF bytes.
type Renderer interface {
	Render(ctx context.Context, job Job) ([]byte, error)
}

// Chrome renders with the headless Chrome at chromeURL (its DevTools
// address), which reaches the app at appURL.
type Chrome struct {
	chromeURL, appURL string
	timeout           time.Duration
	slots             chan struct{}
}

// Timeout is how long a page has to say it's ready.
const Timeout = time.Minute

const (
	// margin is 12 mm in inches, left, right and top.
	margin = 12 / 25.4
	// PageWidth is what's left of A4's 210 mm in CSS pixels (96 an inch):
	// the print page's width (PRINT_WIDTH in the frontend's lib/print.ts).
	PageWidth = 703
)

// NewChrome returns a Renderer using the Chrome at chromeURL. At most two
// renders run at once.
func NewChrome(chromeURL, appURL string) *Chrome {
	return &Chrome{chromeURL: chromeURL, appURL: appURL, timeout: Timeout, slots: make(chan struct{}, 2)}
}

// footer is the page number at the bottom of each page. Chrome fills the
// pageNumber and totalPages spans; the font size must be set.
const footer = `<div style="width:100%;font-size:8px;color:#868e96;text-align:center;font-family:sans-serif">` +
	`<span class="pageNumber"></span> / <span class="totalPages"></span></div>`

// Render prints the job's page to an A4 PDF.
func (c *Chrome) Render(ctx context.Context, job Job) ([]byte, error) {
	select {
	case c.slots <- struct{}{}:
		defer func() { <-c.slots }()
	default:
		return nil, ErrBusy
	}
	devtools, err := devtoolsURL(ctx, c.chromeURL)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	data, err := json.Marshal(job.Data)
	if err != nil {
		return nil, err
	}
	target := c.appURL + job.Page + "#" + base64URL(data)

	allocCtx, cancelAlloc := remote.NewAllocator(ctx, devtools)
	defer cancelAlloc()
	// A tab of its own, closed when done.
	tabCtx, cancelTab := chromedp.NewContext(allocCtx)
	defer cancelTab()
	// Connect first, so a Chrome that isn't there is told apart from a
	// page that fails.
	if err := chromedp.Do(tabCtx); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	runCtx, cancelRun := context.WithTimeout(tabCtx, c.timeout)
	defer cancelRun()

	out, err := printPage(runCtx, job, target)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrFailed, err)
	}
	return out, nil
}

// printPage sets the tab up for the job, loads target, waits for the page to say
// it's ready and prints it.
func printPage(ctx context.Context, job Job, target string) ([]byte, error) {
	if _, err := chromedp.Call(ctx, network.Enable, network.EnableParams{}); err != nil {
		return nil, err
	}
	if _, err := chromedp.Call(ctx, network.SetExtraHTTPHeaders,
		network.SetExtraHTTPHeadersParams{Headers: network.Headers{job.Header: job.Token}}); err != nil {
		return nil, err
	}
	if _, err := chromedp.Call(ctx, emulation.SetTimezoneOverride,
		emulation.SetTimezoneOverrideParams{TimezoneID: job.TimeZone}); err != nil {
		return nil, err
	}
	if job.Locale != "" {
		// ICU style: en_US, not en-US.
		if _, err := chromedp.Call(ctx, emulation.SetLocaleOverride,
			emulation.SetLocaleOverrideParams{Locale: strings.ReplaceAll(job.Locale, "-", "_")}); err != nil {
			return nil, err
		}
	}
	// The page lays out at the printed width, so what it measures on screen
	// (the charts) is what prints.
	if _, err := chromedp.Call(ctx, emulation.SetDeviceMetricsOverride, emulation.SetDeviceMetricsOverrideParams{
		Width: PageWidth, Height: 1000, DeviceScaleFactor: 1,
	}); err != nil {
		return nil, err
	}
	if _, err := chromedp.Call(ctx, emulation.SetEmulatedMedia, emulation.SetEmulatedMediaParams{
		Features: []*emulation.MediaFeature{{Name: "prefers-color-scheme", Value: "light"}},
	}); err != nil {
		return nil, err
	}
	if err := chromedp.Do(ctx, chromedp.Navigate(target)); err != nil {
		return nil, err
	}
	state, err := chromedp.Run(ctx, chromedp.Poll[string](
		`document.querySelector('[data-print-error]') ? 'error' : document.querySelector('[data-print-ready]') ? 'ready' : ''`,
		chromedp.WithPollingInterval(200*time.Millisecond),
		// The context has the deadline.
		chromedp.WithPollingTimeout(0),
	))
	if err != nil {
		return nil, err
	}
	if state != "ready" {
		return nil, errors.New("the page reported an error")
	}
	// A4, 12 mm margins, with room for the page number at the bottom.
	return chromedp.Run(ctx, chromedp.PrintToPDF(
		chromedp.PDFPaper(chromedp.PaperA4),
		chromedp.PDFMargins(margin, margin, 0.6, margin),
		chromedp.PDFPrintBackground(),
		chromedp.PDFHeaderTemplate("<span></span>"),
		chromedp.PDFFooterTemplate(footer),
	))
}

// devtoolsURL turns chromeURL's host into an IP address: Chrome's DevTools
// refuse a Host header that isn't an IP address or localhost.
func devtoolsURL(ctx context.Context, chromeURL string) (string, error) {
	u, err := url.Parse(chromeURL)
	if err != nil {
		return "", err
	}
	host, port := u.Hostname(), u.Port()
	if net.ParseIP(host) == nil && host != "localhost" {
		addrs, err := net.DefaultResolver.LookupHost(ctx, host)
		if err != nil {
			return "", err
		}
		if len(addrs) == 0 {
			return "", fmt.Errorf("no address for %s", host)
		}
		host = addrs[0]
	}
	if port != "" {
		u.Host = net.JoinHostPort(host, port)
	} else {
		u.Host = host
	}
	return u.String(), nil
}

// base64URL is the fragment's encoding: URL-safe, without padding.
func base64URL(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }
