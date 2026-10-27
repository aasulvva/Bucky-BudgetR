// Package web serves the frontend: the files `npm run build` writes to
// source/frontend/dist, embedded in the binary. The Dockerfile copies them
// into dist/ before building; without them (in development, where Vite
// serves the frontend) every page is a 404.
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed all:dist
var embedded embed.FS

// contentSecurityPolicy allows only the app's own scripts, styles and API.
// Mantine sets inline styles, hence 'unsafe-inline' for styles only.
const contentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; " +
	"frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

// Handler serves the embedded frontend.
func Handler() http.Handler {
	dist, err := fs.Sub(embedded, "dist")
	if err != nil {
		panic(err) // the embed pattern guarantees the directory
	}
	return newHandler(dist)
}

// newHandler serves files from dist. Paths that aren't files get index.html,
// so the app's own routes (/admin, /set-password, …) load the app; a missing
// file under /assets/ is a 404 instead, so a stale page doesn't get HTML for
// a script.
func newHandler(dist fs.FS) http.Handler {
	files := http.FileServerFS(dist)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")

		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name != "" && name != "index.html" && isFile(dist, name) {
			if strings.HasPrefix(name, "assets/") {
				// Vite puts a content hash in these names.
				h.Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				h.Set("Cache-Control", "no-cache")
			}
			files.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(name, "assets/") || !isFile(dist, "index.html") {
			http.Error(w, "404 page not found", http.StatusNotFound)
			return
		}
		index, err := fs.ReadFile(dist, "index.html")
		if err != nil {
			http.Error(w, "500 internal server error", http.StatusInternalServerError)
			return
		}
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Cache-Control", "no-cache")
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		h.Set("X-Frame-Options", "DENY")
		if r.Method != http.MethodHead {
			_, _ = w.Write(index)
		}
	})
}

func isFile(dist fs.FS, name string) bool {
	info, err := fs.Stat(dist, name)
	return err == nil && !info.IsDir()
}
