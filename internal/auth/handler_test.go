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

func getJSON(t *testing.T, url, token string) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, raw
}

func TestGitLabUpsertFullName(t *testing.T) {
	_, _, database := testutil.NewServer(t)

	ctx := t.Context()

	// Insert a simulated GitLab user directly (mimicking upsertGitLabUser insert path)
	_, err := database.ExecContext(ctx,
		database.Rebind(`INSERT INTO users(username, email, gitlab_id, gitlab_username, auth_provider, full_name)
		                 VALUES (?, ?, ?, ?, 'gitlab', ?)`),
		"alice_gl", "alice@gitlab.com", 9001, "alice_gl", "Alice Anderson",
	)
	if err != nil {
		t.Fatalf("insert gitlab user: %v", err)
	}

	// Verify full_name stored on insert
	var fn string
	if err := database.QueryRowContext(ctx,
		database.Rebind("SELECT COALESCE(full_name,'') FROM users WHERE gitlab_id = ?"), 9001,
	).Scan(&fn); err != nil {
		t.Fatalf("select full_name: %v", err)
	}
	if fn != "Alice Anderson" {
		t.Errorf("full_name on insert: got %q, want %q", fn, "Alice Anderson")
	}

	// Simulate update path (name changed in GitLab)
	_, err = database.ExecContext(ctx,
		database.Rebind(`UPDATE users SET gitlab_username = ?, email = ?, full_name = ? WHERE gitlab_id = ?`),
		"alice_gl", "alice@gitlab.com", "Alice A. Anderson", 9001,
	)
	if err != nil {
		t.Fatalf("update gitlab user: %v", err)
	}

	if err := database.QueryRowContext(ctx,
		database.Rebind("SELECT COALESCE(full_name,'') FROM users WHERE gitlab_id = ?"), 9001,
	).Scan(&fn); err != nil {
		t.Fatalf("select full_name after update: %v", err)
	}
	if fn != "Alice A. Anderson" {
		t.Errorf("full_name after update: got %q, want %q", fn, "Alice A. Anderson")
	}
}

func TestSearchUsersFullName(t *testing.T) {
	srv, _, database := testutil.NewServer(t)

	ctx := t.Context()

	// Register the searching user so we have a valid token
	token := register(t, srv.URL, "searcher", "searcher@example.com", "password1234")

	// Seed a user with a full_name directly in the DB
	_, err := database.ExecContext(ctx,
		database.Rebind(`INSERT INTO users(username, email, password_hash, full_name) VALUES (?, ?, ?, ?)`),
		"aanderson", "aanderson@example.com", "x", "Alice Anderson",
	)
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}

	// Search by full-name substring
	resp, raw := getJSON(t, srv.URL+"/api/users?q=ander", token)
	if resp.StatusCode != 200 {
		t.Fatalf("search users: status=%d body=%s", resp.StatusCode, raw)
	}
	var results []struct {
		ID       int    `json:"id"`
		Username string `json:"username"`
		FullName string `json:"fullName"`
	}
	if err := json.Unmarshal(raw, &results); err != nil {
		t.Fatalf("parse results: %v", err)
	}
	found := false
	for _, u := range results {
		if u.Username == "aanderson" {
			found = true
			if u.FullName != "Alice Anderson" {
				t.Errorf("fullName: got %q, want %q", u.FullName, "Alice Anderson")
			}
		}
	}
	if !found {
		t.Errorf("user aanderson not found in results: %s", raw)
	}

	// Also verify search by username still works
	resp, raw = getJSON(t, srv.URL+"/api/users?q=aanderson", token)
	if resp.StatusCode != 200 {
		t.Fatalf("search by username: status=%d", resp.StatusCode)
	}
	results = nil
	_ = json.Unmarshal(raw, &results)
	if len(results) == 0 {
		t.Errorf("search by username returned nothing")
	}
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
