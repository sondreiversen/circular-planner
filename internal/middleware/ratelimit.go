package middleware

import (
	"encoding/json"
	"net"
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

	// Tighter limits for unauthenticated auth endpoints (login, register) —
	// these have no user context and are brute-force targets.
	authAttemptRate  = 10.0 // tokens refilled per 60s window
	authAttemptBurst = 5.0  // maximum burst
)

type rateLimiterEntry struct {
	mu         sync.Mutex
	tokens     float64
	lastRefill time.Time
	lastSeen   time.Time
}

// refill adds tokens proportional to elapsed time since last refill, capped
// at burst. rate is tokens per refillPeriod (always 60s).
func (e *rateLimiterEntry) refill(now time.Time, rate, burst float64) {
	elapsed := now.Sub(e.lastRefill)
	if elapsed <= 0 {
		return
	}
	add := elapsed.Seconds() * (rate / refillPeriod.Seconds())
	e.tokens += add
	if e.tokens > burst {
		e.tokens = burst
	}
	e.lastRefill = now
}

// allow returns true if a token can be consumed, false if rate-limited.
func (e *rateLimiterEntry) allow(now time.Time, rate, burst float64) bool {
	e.refill(now, rate, burst)
	e.lastSeen = now
	if e.tokens >= 1 {
		e.tokens--
		return true
	}
	return false
}

// retryAfterSeconds estimates seconds until one token is available.
func (e *rateLimiterEntry) retryAfterSeconds(rate float64) int {
	needed := 1.0 - e.tokens
	if needed <= 0 {
		return 1
	}
	secs := needed / (rate / refillPeriod.Seconds())
	if secs < 1 {
		return 1
	}
	return int(secs) + 1
}

var (
	mutBuckets  sync.Map // key string → *rateLimiterEntry (mutation limit)
	authBuckets sync.Map // key string → *rateLimiterEntry (login/register limit)
	janitorOnce sync.Once
)

func startJanitor() {
	go func() {
		for {
			time.Sleep(janitorPeriod)
			cutoff := time.Now().Add(-idleTimeout)
			gc := func(m *sync.Map) {
				m.Range(func(k, v interface{}) bool {
					e := v.(*rateLimiterEntry)
					e.mu.Lock()
					idle := e.lastSeen.Before(cutoff)
					e.mu.Unlock()
					if idle {
						m.Delete(k)
					}
					return true
				})
			}
			gc(&mutBuckets)
			gc(&authBuckets)
		}
	}()
}

// clientIP extracts the client IP from r.RemoteAddr, optionally honouring
// the leftmost X-Forwarded-For entry when trustProxy is set. Returns the
// IP without port — handles IPv6 (where r.RemoteAddr is "[::1]:1234").
func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			// Take the leftmost (original client) hop.
			if comma := strings.IndexByte(xff, ','); comma >= 0 {
				xff = xff[:comma]
			}
			if ip := strings.TrimSpace(xff); ip != "" {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func bucketKey(r *http.Request) string {
	// Prefer authenticated user ID over IP so shared IPs aren't penalised together.
	if u := UserFrom(r); u != nil {
		return "u:" + strconv.Itoa(u.ID)
	}
	// TrustProxy=false here is conservative — falls back to RemoteAddr only.
	// (Mutations is for authed paths; the auth-attempt limiter does honour
	// X-Forwarded-For when configured.)
	return "ip:" + clientIP(r, false)
}

func isMutation(r *http.Request) bool {
	switch r.Method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	}
	return false
}

func getOrCreate(m *sync.Map, key string, burst float64) *rateLimiterEntry {
	now := time.Now()
	v, _ := m.LoadOrStore(key, &rateLimiterEntry{
		tokens:     burst,
		lastRefill: now,
		lastSeen:   now,
	})
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
			entry := getOrCreate(&mutBuckets, key, mutationBurst)
			entry.mu.Lock()
			ok := entry.allow(time.Now(), mutationRate, mutationBurst)
			retry := 0
			if !ok {
				retry = entry.retryAfterSeconds(mutationRate)
			}
			entry.mu.Unlock()

			if !ok {
				writeRateLimited(w, retry)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// AuthAttempts returns middleware that throttles unauthenticated auth
// endpoints (login, register). Always keyed by client IP — there's no user
// context here, so this is the brute-force defence. Honours X-Forwarded-For
// when trustProxy is true. Uses a separate token bucket from Mutations() so
// normal API quota isn't burned by failed logins.
//
// Limit: 10 attempts per minute, burst 5.
func AuthAttempts(trustProxy bool) func(http.Handler) http.Handler {
	janitorOnce.Do(startJanitor)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := "auth:" + clientIP(r, trustProxy)
			entry := getOrCreate(&authBuckets, key, authAttemptBurst)
			entry.mu.Lock()
			ok := entry.allow(time.Now(), authAttemptRate, authAttemptBurst)
			retry := 0
			if !ok {
				retry = entry.retryAfterSeconds(authAttemptRate)
			}
			entry.mu.Unlock()

			if !ok {
				writeRateLimited(w, retry)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func writeRateLimited(w http.ResponseWriter, retry int) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Retry-After", strconv.Itoa(retry))
	w.WriteHeader(http.StatusTooManyRequests)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"error":         "rate_limited",
		"retry_after_s": retry,
	})
}

