package middleware

import (
	"crypto/rand"
	"fmt"
	"net/http"

	"planner/internal/db"
)

// RequestID is middleware that ensures every request carries a unique request ID.
// It accepts an incoming X-Request-Id header if present and non-empty, otherwise
// generates a UUID v4. The ID is echoed as an X-Request-Id response header and
// stored on the request context via db.WithRequestID so the slow-query logger
// can correlate DB calls with the originating HTTP request.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if id == "" {
			id = newUUID()
		}
		w.Header().Set("X-Request-Id", id)
		ctx := db.WithRequestID(r.Context(), id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// newUUID generates a random UUID v4 using crypto/rand.
func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	// Set version 4
	b[6] = (b[6] & 0x0f) | 0x40
	// Set variant bits
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
