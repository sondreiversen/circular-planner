package middleware

import (
	"net/http"
	"testing"
)

func newTestRequest(t *testing.T, remoteAddr, xff string) *http.Request {
	t.Helper()
	req, err := http.NewRequest("GET", "http://example.com/", nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.RemoteAddr = remoteAddr
	if xff != "" {
		req.Header.Set("X-Forwarded-For", xff)
	}
	return req
}

func TestClientIP_NoXFF_UsesRemoteAddr(t *testing.T) {
	req := newTestRequest(t, "203.0.113.5:54321", "")
	got := clientIP(req, true)
	if got != "203.0.113.5" {
		t.Errorf("got %q, want %q", got, "203.0.113.5")
	}
}

func TestClientIP_SingleXFFEntry(t *testing.T) {
	req := newTestRequest(t, "10.0.0.1:1234", "198.51.100.9")
	got := clientIP(req, true)
	if got != "198.51.100.9" {
		t.Errorf("got %q, want %q", got, "198.51.100.9")
	}
}

func TestClientIP_MultiHop_RightmostWins(t *testing.T) {
	// Chain: original client, then two trusted proxy hops. The rightmost
	// entry is the one our own trusted proxy appended.
	req := newTestRequest(t, "10.0.0.1:1234", "203.0.113.7, 192.168.1.1, 192.168.1.2")
	got := clientIP(req, true)
	if got != "192.168.1.2" {
		t.Errorf("got %q, want %q (rightmost hop)", got, "192.168.1.2")
	}
}

func TestClientIP_SpoofedLeftEntry_Ignored(t *testing.T) {
	// A client can set any value it likes as the leftmost X-Forwarded-For
	// entry (e.g. a fresh random IP on every request to dodge the limiter).
	// Only the rightmost, proxy-appended entry should be trusted.
	req1 := newTestRequest(t, "10.0.0.1:1234", "1.1.1.1, 192.168.1.1")
	req2 := newTestRequest(t, "10.0.0.1:1234", "2.2.2.2, 192.168.1.1")
	got1 := clientIP(req1, true)
	got2 := clientIP(req2, true)
	if got1 != "192.168.1.1" || got2 != "192.168.1.1" {
		t.Errorf("spoofed leftmost entries produced different keys: %q vs %q, want both %q", got1, got2, "192.168.1.1")
	}
}

func TestClientIP_IPv6RemoteAddr(t *testing.T) {
	req := newTestRequest(t, "[::1]:54321", "")
	got := clientIP(req, true)
	if got != "::1" {
		t.Errorf("got %q, want %q", got, "::1")
	}
}

func TestClientIP_TrustProxyFalse_IgnoresXFF(t *testing.T) {
	req := newTestRequest(t, "203.0.113.5:54321", "9.9.9.9, 8.8.8.8")
	got := clientIP(req, false)
	if got != "203.0.113.5" {
		t.Errorf("got %q, want %q (XFF should be ignored when trustProxy is false)", got, "203.0.113.5")
	}
}
