package planners_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"

	"planner/internal/testutil"
)

func do(t *testing.T, method, url, token string, body any) (*http.Response, []byte) {
	t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, url, r)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, raw
}

func registerHelper(t *testing.T, base, u, e, p string) string {
	t.Helper()
	resp, raw := do(t, "POST", base+"/api/auth/register", "",
		map[string]string{"username": u, "email": e, "password": p})
	if resp.StatusCode != 200 {
		t.Fatalf("register: %d %s", resp.StatusCode, raw)
	}
	var out struct{ Token string }
	json.Unmarshal(raw, &out)
	return out.Token
}

func TestPlannerCRUDAndOwnership(t *testing.T) {
	srv, _, _ := testutil.NewServer(t)

	aliceTok := registerHelper(t, srv.URL, "alice", "alice@example.com", "hunter2hunter2")
	bobTok := registerHelper(t, srv.URL, "bob", "bob@example.com", "hunter2hunter2")

	// Alice creates a planner
	resp, raw := do(t, "POST", srv.URL+"/api/planners", aliceTok,
		map[string]string{"title": "My Year", "startDate": "2026-01-01", "endDate": "2026-12-31"})
	if resp.StatusCode != 201 {
		t.Fatalf("create: %d %s", resp.StatusCode, raw)
	}
	var created struct{ ID int }
	json.Unmarshal(raw, &created)
	if created.ID == 0 {
		t.Fatalf("create returned no id: %s", raw)
	}

	// Alice can GET her planner
	resp, _ = do(t, "GET", fmt.Sprintf("%s/api/planners/%d", srv.URL, created.ID), aliceTok, nil)
	if resp.StatusCode != 200 {
		t.Errorf("owner GET: got %d, want 200", resp.StatusCode)
	}

	// Bob CANNOT GET Alice's planner
	resp, _ = do(t, "GET", fmt.Sprintf("%s/api/planners/%d", srv.URL, created.ID), bobTok, nil)
	if resp.StatusCode != 403 && resp.StatusCode != 404 {
		t.Errorf("cross-user GET: got %d, want 403 or 404", resp.StatusCode)
	}

	// Bob CANNOT DELETE Alice's planner
	resp, _ = do(t, "DELETE", fmt.Sprintf("%s/api/planners/%d", srv.URL, created.ID), bobTok, nil)
	if resp.StatusCode != 403 && resp.StatusCode != 404 {
		t.Errorf("cross-user DELETE: got %d, want 403 or 404", resp.StatusCode)
	}

	// Invalid planner id → 400 or 404
	resp, _ = do(t, "GET", srv.URL+"/api/planners/not-a-number", aliceTok, nil)
	if resp.StatusCode != 400 && resp.StatusCode != 404 {
		t.Errorf("invalid id: got %d, want 400 or 404", resp.StatusCode)
	}

	// Alice can DELETE her planner
	resp, _ = do(t, "DELETE", fmt.Sprintf("%s/api/planners/%d", srv.URL, created.ID), aliceTok, nil)
	if resp.StatusCode != 200 {
		t.Errorf("owner DELETE: got %d, want 200", resp.StatusCode)
	}
}

func TestListRequiresAuth(t *testing.T) {
	srv, _, _ := testutil.NewServer(t)
	resp, _ := http.Get(srv.URL + "/api/planners")
	if resp.StatusCode != 401 {
		t.Errorf("unauthenticated list: got %d, want 401", resp.StatusCode)
	}
}

func TestConcurrentEditConflict(t *testing.T) {
	srv, _, _ := testutil.NewServer(t)

	tok := registerHelper(t, srv.URL, "carol", "carol@example.com", "hunter2hunter2")

	// Create a planner
	resp, raw := do(t, "POST", srv.URL+"/api/planners", tok,
		map[string]string{"title": "Conflict Test", "startDate": "2026-01-01", "endDate": "2026-12-31"})
	if resp.StatusCode != 201 {
		t.Fatalf("create: %d %s", resp.StatusCode, raw)
	}
	var created struct{ ID int }
	json.Unmarshal(raw, &created)

	// GET the planner to retrieve updated_at
	resp, raw = do(t, "GET", fmt.Sprintf("%s/api/planners/%d", srv.URL, created.ID), tok, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("get: %d %s", resp.StatusCode, raw)
	}
	var getResp struct {
		Config struct {
			UpdatedAt string `json:"updated_at"`
		} `json:"config"`
	}
	json.Unmarshal(raw, &getResp)
	if getResp.Config.UpdatedAt == "" {
		t.Fatal("GET did not return updated_at in config")
	}

	// PUT with a stale client_updated_at (far in the past) → 409
	resp, raw = do(t, "PUT", fmt.Sprintf("%s/api/planners/%d", srv.URL, created.ID), tok, map[string]any{
		"title":             "Updated",
		"startDate":         "2026-01-01",
		"endDate":           "2026-12-31",
		"lanes":             []any{},
		"client_updated_at": "2000-01-01T00:00:00Z",
	})
	if resp.StatusCode != 409 {
		t.Errorf("stale PUT: got %d, want 409 (body: %s)", resp.StatusCode, raw)
	}

	// PUT with correct client_updated_at → 200
	resp, raw = do(t, "PUT", fmt.Sprintf("%s/api/planners/%d", srv.URL, created.ID), tok, map[string]any{
		"title":             "Updated",
		"startDate":         "2026-01-01",
		"endDate":           "2026-12-31",
		"lanes":             []any{},
		"client_updated_at": getResp.Config.UpdatedAt,
	})
	if resp.StatusCode != 200 {
		t.Errorf("fresh PUT: got %d, want 200 (body: %s)", resp.StatusCode, raw)
	}
}
