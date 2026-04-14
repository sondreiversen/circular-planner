package auth_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"planner/internal/testutil"
)

func postJSON(t *testing.T, url string, body any, token string) (*http.Response, []byte) {
	t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, raw
}

func register(t *testing.T, base, username, email, password string) string {
	t.Helper()
	resp, raw := postJSON(t, base+"/api/auth/register",
		map[string]string{"username": username, "email": email, "password": password}, "")
	if resp.StatusCode != 200 {
		t.Fatalf("register %s: status=%d body=%s", username, resp.StatusCode, raw)
	}
	var out struct{ Token string }
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("register parse: %v", err)
	}
	if out.Token == "" {
		t.Fatalf("register returned empty token: %s", raw)
	}
	return out.Token
}

func TestAuthFlow(t *testing.T) {
	srv, _, _ := testutil.NewServer(t)

	token := register(t, srv.URL, "alice", "alice@example.com", "hunter2hunter2")

	// /me with token
	req, _ := http.NewRequest("GET", srv.URL+"/api/auth/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /me: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("GET /me status=%d", resp.StatusCode)
	}
	resp.Body.Close()

	// Login with correct password
	resp, raw := postJSON(t, srv.URL+"/api/auth/login",
		map[string]string{"email": "alice@example.com", "password": "hunter2hunter2"}, "")
	if resp.StatusCode != 200 {
		t.Fatalf("login: status=%d body=%s", resp.StatusCode, raw)
	}

	// Wrong password → 401
	resp, _ = postJSON(t, srv.URL+"/api/auth/login",
		map[string]string{"email": "alice@example.com", "password": "wrong-password"}, "")
	if resp.StatusCode != 401 {
		t.Errorf("wrong password: got %d, want 401", resp.StatusCode)
	}

	// Duplicate email → 409
	resp, _ = postJSON(t, srv.URL+"/api/auth/register",
		map[string]string{"username": "alice2", "email": "alice@example.com", "password": "hunter2hunter2"}, "")
	if resp.StatusCode != 409 {
		t.Errorf("duplicate email: got %d, want 409", resp.StatusCode)
	}

	// /me without token → 401
	resp, _ = http.Get(srv.URL + "/api/auth/me")
	if resp.StatusCode != 401 {
		t.Errorf("no token: got %d, want 401", resp.StatusCode)
	}

	// /me with bad token → 401
	req, _ = http.NewRequest("GET", srv.URL+"/api/auth/me", nil)
	req.Header.Set("Authorization", "Bearer "+strings.Repeat("x", 40))
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != 401 {
		t.Errorf("bad token: got %d, want 401", resp.StatusCode)
	}
}
