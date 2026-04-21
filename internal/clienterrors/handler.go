// Package clienterrors implements POST /api/client-errors — an unauthenticated
// endpoint that accepts browser-side error reports and logs them as structured
// JSON to stdout.
package clienterrors

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"sync"
	"time"
)

const maxBodyBytes = 4 * 1024 // 4 KB

// rateLimiter is a simple per-IP sliding-window counter (30 req/min).
type rateLimiter struct {
	mu      sync.Mutex
	buckets map[string][]time.Time
}

var limiter = &rateLimiter{buckets: make(map[string][]time.Time)}

func (rl *rateLimiter) allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	window := now.Add(-time.Minute)
	hits := rl.buckets[ip]
	// Prune old entries
	j := 0
	for _, t := range hits {
		if t.After(window) {
			hits[j] = t
			j++
		}
	}
	hits = hits[:j]
	if len(hits) >= 30 {
		rl.buckets[ip] = hits
		return false
	}
	rl.buckets[ip] = append(hits, now)
	return true
}

// Handler handles the client-errors route.
type Handler struct{}

func NewHandler() *Handler { return &Handler{} }

// Register mounts the client-errors route. No authentication required.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/client-errors", h.Report)
}

// POST /api/client-errors — logs a structured error line; returns 204.
func (h *Handler) Report(w http.ResponseWriter, r *http.Request) {
	ip := r.RemoteAddr
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		ip = xff
	}

	if !limiter.allow(ip) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"rate_limited"}`))
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes))
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	var b struct {
		Message any `json:"message"`
		Stack   any `json:"stack"`
		URL     any `json:"url"`
		Line    any `json:"line"`
		Col     any `json:"col"`
		UA      any `json:"ua"`
		TS      any `json:"ts"`
	}
	_ = json.Unmarshal(body, &b)

	ts := b.TS
	if ts == nil {
		ts = time.Now().UTC().Format(time.RFC3339)
	}

	msg := ""
	if b.Message != nil {
		switch v := b.Message.(type) {
		case string:
			msg = v
		default:
			if d, err := json.Marshal(v); err == nil {
				msg = string(d)
			}
		}
	}

	entry := map[string]any{
		"level":   "client-error",
		"message": msg,
		"stack":   b.Stack,
		"url":     b.URL,
		"line":    b.Line,
		"col":     b.Col,
		"ua":      b.UA,
		"ts":      ts,
	}
	out, _ := json.Marshal(entry)
	log.Println(string(out))

	w.WriteHeader(http.StatusNoContent)
}
