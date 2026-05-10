package middleware

import (
	"crypto/sha256"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// StaticCache wraps a static-file handler with ETag-based caching and
// Cache-Control headers. It walks the embedded FS once at construction time
// to pre-compute SHA-256 ETags for every file.
//
// Cache-Control policy:
//   - .js, .css, .svg  →  public, max-age=3600, must-revalidate
//   - .html and others →  no-cache  (forces revalidation; 304s are still served)
//
// If the path is not in the map (SPA fallback), no ETag is set and no-cache is used.
func NewStaticCache(fsys fs.FS, next http.Handler) http.Handler {
	etags := buildETagMap(fsys)
	return &staticCacheHandler{etags: etags, next: next}
}

type staticCacheHandler struct {
	etags map[string]string // URL path → quoted ETag value, e.g. `"abc123def456"`
	next  http.Handler
}

func (h *staticCacheHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	urlPath := r.URL.Path
	// Normalise: remove trailing slash, ensure leading slash.
	urlPath = path.Clean("/" + urlPath)

	etag, found := h.etags[urlPath]

	if found {
		w.Header().Set("ETag", etag)

		// Check If-None-Match — simple exact-match (no wildcard needed for static files).
		if inm := r.Header.Get("If-None-Match"); inm == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}

		// Set Cache-Control based on file extension.
		ext := strings.ToLower(path.Ext(urlPath))
		switch ext {
		case ".js", ".css", ".svg":
			w.Header().Set("Cache-Control", "public, max-age=3600, must-revalidate")
		default:
			w.Header().Set("Cache-Control", "no-cache")
		}
	} else {
		// SPA fallback or unknown path.
		w.Header().Set("Cache-Control", "no-cache")
	}

	h.next.ServeHTTP(w, r)
}

// buildETagMap walks the embedded FS and computes a 16-hex-char SHA-256 prefix
// for every regular file, keyed by URL path ("/js/planner-bundle.js", etc.).
func buildETagMap(fsys fs.FS) map[string]string {
	m := make(map[string]string)
	_ = fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		hash, hashErr := hashFile(fsys, p)
		if hashErr != nil {
			return nil
		}
		// Convert FS path ("js/planner-bundle.js") → URL path ("/js/planner-bundle.js").
		urlPath := "/" + p
		m[urlPath] = `"` + hash + `"`
		return nil
	})
	return m
}

// hashFile reads a file from an FS and returns the first 16 hex chars of its SHA-256 digest.
func hashFile(fsys fs.FS, name string) (string, error) {
	f, err := fsys.Open(name)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", h.Sum(nil))[:16], nil
}
