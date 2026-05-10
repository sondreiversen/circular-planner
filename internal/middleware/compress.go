// Package middleware provides HTTP middleware for the planner server.
package middleware

import (
	"compress/gzip"
	"net/http"
	"strings"
	"sync"
)

// compressibleTypes lists MIME type prefixes that should be gzip-compressed.
// application/json is deliberately excluded (BREACH-class concern).
var compressibleTypes = []string{
	"text/html",
	"text/css",
	"application/javascript",
	"text/javascript",
	"image/svg+xml",
}

var gzipPool = sync.Pool{
	New: func() any {
		w, _ := gzip.NewWriterLevel(nil, gzip.DefaultCompression)
		return w
	},
}

// Compress wraps a static-file handler with gzip compression.
// It only compresses when:
//   - The request has Accept-Encoding: gzip
//   - The response Content-Type matches a compressible type
//
// It skips compression for:
//   - WebSocket upgrade requests (Connection: upgrade)
//   - Range requests
func Compress(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Skip upgrade (WebSocket) and range requests.
		if strings.EqualFold(r.Header.Get("Connection"), "upgrade") {
			next.ServeHTTP(w, r)
			return
		}
		if r.Header.Get("Range") != "" {
			next.ServeHTTP(w, r)
			return
		}
		// Skip if client doesn't accept gzip.
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			next.ServeHTTP(w, r)
			return
		}

		// Wrap the ResponseWriter; the gzip writer is created lazily on first write
		// so we can inspect Content-Type before deciding whether to compress.
		grw := &gzipResponseWriter{ResponseWriter: w}
		defer grw.close()

		w.Header().Set("Vary", "Accept-Encoding")
		next.ServeHTTP(grw, r)
	})
}

type gzipResponseWriter struct {
	http.ResponseWriter
	gz          *gzip.Writer
	wroteHeader bool
	skip        bool // true when Content-Type is non-compressible
}

func (g *gzipResponseWriter) WriteHeader(status int) {
	if !g.wroteHeader {
		g.wroteHeader = true
		ct := g.Header().Get("Content-Type")
		if isCompressible(ct) {
			gz := gzipPool.Get().(*gzip.Writer)
			gz.Reset(g.ResponseWriter)
			g.gz = gz
			g.Header().Del("Content-Length")
			g.Header().Set("Content-Encoding", "gzip")
		} else {
			g.skip = true
		}
	}
	g.ResponseWriter.WriteHeader(status)
}

func (g *gzipResponseWriter) Write(b []byte) (int, error) {
	if !g.wroteHeader {
		g.WriteHeader(http.StatusOK)
	}
	if g.gz != nil {
		return g.gz.Write(b)
	}
	return g.ResponseWriter.Write(b)
}

func (g *gzipResponseWriter) close() {
	if g.gz != nil {
		_ = g.gz.Close()
		gzipPool.Put(g.gz)
		g.gz = nil
	}
}

// isCompressible reports whether the Content-Type is eligible for gzip compression.
func isCompressible(ct string) bool {
	if ct == "" {
		return false
	}
	// Strip parameters (e.g. "; charset=utf-8")
	if i := strings.Index(ct, ";"); i >= 0 {
		ct = strings.TrimSpace(ct[:i])
	}
	for _, prefix := range compressibleTypes {
		if strings.HasPrefix(ct, prefix) {
			return true
		}
	}
	return false
}
