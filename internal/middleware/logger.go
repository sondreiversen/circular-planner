package middleware

import (
	"encoding/json"
	"net/http"
	"os"
	"time"

	"planner/internal/db"
)

// loggingResponseWriter wraps http.ResponseWriter to capture status code and bytes written.
type loggingResponseWriter struct {
	http.ResponseWriter
	status       int
	bytesWritten int
}

func (lrw *loggingResponseWriter) WriteHeader(status int) {
	lrw.status = status
	lrw.ResponseWriter.WriteHeader(status)
}

func (lrw *loggingResponseWriter) Write(b []byte) (int, error) {
	n, err := lrw.ResponseWriter.Write(b)
	lrw.bytesWritten += n
	return n, err
}

// JSONLogger is middleware that emits a single structured JSON log line to
// stdout after each request completes. Fields:
//
//	ts            — ISO 8601 timestamp
//	request_id    — from db.RequestIDFrom (set by RequestID middleware)
//	user_id       — integer user ID if authenticated, null otherwise
//	method        — HTTP method
//	path          — request URL path
//	status        — HTTP status code
//	duration_ms   — handler duration in milliseconds
func JSONLogger(next http.Handler) http.Handler {
	enc := json.NewEncoder(os.Stdout)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		lrw := &loggingResponseWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(lrw, r)
		dur := time.Since(start)

		requestID := db.RequestIDFrom(r.Context())

		var userID interface{}
		if u := UserFrom(r); u != nil {
			userID = u.ID
		}

		entry := map[string]interface{}{
			"ts":          start.UTC().Format(time.RFC3339),
			"request_id":  requestID,
			"user_id":     userID,
			"method":      r.Method,
			"path":        r.URL.Path,
			"status":      lrw.status,
			"duration_ms": dur.Milliseconds(),
		}
		_ = enc.Encode(entry)
	})
}
