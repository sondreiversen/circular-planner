package middleware

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	mutationRate  = 60.0 // tokens refilled per 60s window
	mutationBurst = 10.0 // maximum burst
	refillPeriod  = 60 * time.Second
	janitorPeriod = 5 * time.Minute
	idleTimeout   = 10 * time.Minute
)

type rateLimiterEntry struct {
	mu         sync.Mutex
	tokens     float64
	lastRefill time.Time
	lastSeen   time.Time
}

// refill adds tokens proportional to elapsed time since last refill,
// capped at mutationBurst.
func (e *rateLimiterEntry) refill(now time.Time) {
	elapsed := now.Sub(e.lastRefill)
	if elapsed <= 0 {
		return
	}
	add := elapsed.Seconds() * (mutationRate / refillPeriod.Seconds())
	e.tokens += add
	if e.tokens > mutationBurst {
		e.tokens = mutationBurst
	}
	e.lastRefill = now
}

// allow returns true if a token can be consumed, false if rate-limited.
func (e *rateLimiterEntry) allow(now time.Time) bool {
	e.refill(now)
	e.lastSeen = now
	if e.tokens >= 1 {
		e.tokens--
		return true
	}
	return false
}

// retryAfterSeconds estimates seconds until one token is available.
func (e *rateLimiterEntry) retryAfterSeconds() int {
	// Time until 1 token at current rate
	needed := 1.0 - e.tokens
	if needed <= 0 {
		return 1
	}
	secs := needed / (mutationRate / refillPeriod.Seconds())
	if secs < 1 {
		return 1
	}
	return int(secs) + 1
}

var (
	mutBuckets sync.Map // key string → *rateLimiterEntry
	janitorOnce sync.Once
)

func startJanitor() {
	go func() {
		for {
			time.Sleep(janitorPeriod)
			cutoff := time.Now().Add(-idleTimeout)
			mutBuckets.Range(func(k, v interface{}) bool {
				e := v.(*rateLimiterEntry)
				e.mu.Lock()
				idle := e.lastSeen.Before(cutoff)
				e.mu.Unlock()
				if idle {
					mutBuckets.Delete(k)
				}
				return true
			})
		}
	}()
}

func bucketKey(r *http.Request) string {
	// Prefer authenticated user ID over IP so shared IPs aren't penalised together.
	if u := UserFrom(r); u != nil {
		return "u:" + strconv.Itoa(u.ID)
	}
	ip := r.RemoteAddr
	// Strip port
	if i := strings.LastIndex(ip, ":"); i >= 0 {
		ip = ip[:i]
	}
	return "ip:" + ip
}

func isMutation(r *http.Request) bool {
	switch r.Method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	}
	return false
}

func getOrCreate(key string) *rateLimiterEntry {
	now := time.Now()
	v, loaded := mutBuckets.LoadOrStore(key, &rateLimiterEntry{
		tokens:     mutationBurst,
		lastRefill: now,
		lastSeen:   now,
	})
	if loaded {
		return v.(*rateLimiterEntry)
	}
	return v.(*rateLimiterEntry)
}

// Mutations returns middleware that applies a token-bucket rate limit (60 req/60s,
// burst 10) to mutating HTTP methods (POST, PUT, PATCH, DELETE). GET/HEAD/OPTIONS
// pass through unconditionally. The bucket key is the authenticated user ID when
// available, otherwise the client IP.
//
// A 429 JSON response is returned when the limit is exceeded:
//
//	{"error":"rate_limited","retry_after_s":N}
func Mutations() func(http.Handler) http.Handler {
	janitorOnce.Do(startJanitor)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !isMutation(r) {
				next.ServeHTTP(w, r)
				return
			}
			key := bucketKey(r)
			entry := getOrCreate(key)
			entry.mu.Lock()
			ok := entry.allow(time.Now())
			retry := 0
			if !ok {
				retry = entry.retryAfterSeconds()
			}
			entry.mu.Unlock()

			if !ok {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Retry-After", strconv.Itoa(retry))
				w.WriteHeader(http.StatusTooManyRequests)
				_ = json.NewEncoder(w).Encode(map[string]interface{}{
					"error":          "rate_limited",
					"retry_after_s":  retry,
				})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

