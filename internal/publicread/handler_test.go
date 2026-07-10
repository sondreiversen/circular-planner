package publicread_test

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

func register(t *testing.T, base, username, email, password string) string {
	t.Helper()
	resp, raw := do(t, "POST", base+"/api/auth/register", "",
		map[string]string{"username": username, "email": email, "password": password})
	if resp.StatusCode != 200 {
		t.Fatalf("register %s: %d %s", username, resp.StatusCode, raw)
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

func createPlanner(t *testing.T, base, token, title string) int {
	t.Helper()
	resp, raw := do(t, "POST", base+"/api/planners", token,
		map[string]string{"title": title, "startDate": "2026-01-01", "endDate": "2026-12-31"})
	if resp.StatusCode != 201 {
		t.Fatalf("create planner: %d %s", resp.StatusCode, raw)
	}
	var created struct{ ID int }
	json.Unmarshal(raw, &created)
	if created.ID == 0 {
		t.Fatalf("create planner returned no id: %s", raw)
	}
	return created.ID
}

// TestPublicReadViaShareToken verifies that a planner becomes readable without
// any auth once the owner mints a share token, and that the payload matches
// the public-read contract: permission is always "view", isOwner is always
// false, and lanes/activities are present.
func TestPublicReadViaShareToken(t *testing.T) {
	srv, _, _ := testutil.NewServer(t)

	ownerTok := register(t, srv.URL, "pub-owner", "pub-owner@example.com", "hunter2hunter2")
	plannerID := createPlanner(t, srv.URL, ownerTok, "Public Planner")

	// Add a lane + activity so we can verify the public payload carries data.
	resp, raw := do(t, "PUT", fmt.Sprintf("%s/api/planners/%d", srv.URL, plannerID), ownerTok, map[string]any{
		"lanes": []any{
			map[string]any{
				"id": "lane1", "name": "Lane One", "order": 1, "color": "#ff0000",
				"activities": []any{
					map[string]any{
						"id": "act1", "laneId": "lane1", "title": "Launch",
						"description": "", "startDate": "2026-03-01", "endDate": "2026-03-02",
						"color": "#000", "label": "",
					},
				},
			},
		},
	})
	if resp.StatusCode != 200 {
		t.Fatalf("PUT lanes: %d %s", resp.StatusCode, raw)
	}

	// Before minting a token, a random token is not found.
	resp, raw = do(t, "GET", srv.URL+"/api/public/planners/does-not-exist", "", nil)
	if resp.StatusCode != 404 {
		t.Errorf("unknown token: got %d, want 404 (body: %s)", resp.StatusCode, raw)
	}

	// Owner mints a share token.
	resp, raw = do(t, "POST", fmt.Sprintf("%s/api/planners/%d/share-tokens", srv.URL, plannerID), ownerTok, nil)
	if resp.StatusCode != 201 && resp.StatusCode != 200 {
		t.Fatalf("create share token: %d %s", resp.StatusCode, raw)
	}
	var tokenResp struct {
		Token string `json:"token"`
	}
	json.Unmarshal(raw, &tokenResp)
	if tokenResp.Token == "" {
		t.Fatalf("no token in response: %s", raw)
	}

	// The public endpoint is readable with NO Authorization header at all.
	resp, raw = do(t, "GET", srv.URL+"/api/public/planners/"+tokenResp.Token, "", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("public read: %d %s", resp.StatusCode, raw)
	}

	var out struct {
		Config struct {
			PlannerID  int    `json:"plannerId"`
			Title      string `json:"title"`
			IsOwner    bool   `json:"isOwner"`
			Permission string `json:"permission"`
		} `json:"config"`
		Data struct {
			Lanes []struct {
				ID         string `json:"id"`
				Activities []struct {
					ID    string `json:"id"`
					Title string `json:"title"`
				} `json:"activities"`
			} `json:"lanes"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal public read: %v (body: %s)", err, raw)
	}
	if out.Config.PlannerID != plannerID {
		t.Errorf("plannerId: got %d, want %d", out.Config.PlannerID, plannerID)
	}
	if out.Config.Title != "Public Planner" {
		t.Errorf("title: got %q, want %q", out.Config.Title, "Public Planner")
	}
	if out.Config.IsOwner {
		t.Error("isOwner: got true, want false for public read")
	}
	if out.Config.Permission != "view" {
		t.Errorf("permission: got %q, want %q", out.Config.Permission, "view")
	}
	if len(out.Data.Lanes) != 1 || len(out.Data.Lanes[0].Activities) != 1 {
		t.Fatalf("expected 1 lane with 1 activity, got: %+v", out.Data)
	}
	if out.Data.Lanes[0].Activities[0].Title != "Launch" {
		t.Errorf("activity title: got %q, want %q", out.Data.Lanes[0].Activities[0].Title, "Launch")
	}
}

// TestPublicReadRevokedTokenNotFound verifies that once a share token is
// revoked (the planner is no longer "public" via that link), the public
// endpoint no longer serves it — it must behave like an unknown planner
// rather than leaking any data.
func TestPublicReadRevokedTokenNotFound(t *testing.T) {
	srv, _, _ := testutil.NewServer(t)

	ownerTok := register(t, srv.URL, "pub-owner2", "pub-owner2@example.com", "hunter2hunter2")
	plannerID := createPlanner(t, srv.URL, ownerTok, "Revocable Planner")

	resp, raw := do(t, "POST", fmt.Sprintf("%s/api/planners/%d/share-tokens", srv.URL, plannerID), ownerTok, nil)
	if resp.StatusCode != 201 && resp.StatusCode != 200 {
		t.Fatalf("create share token: %d %s", resp.StatusCode, raw)
	}
	var tokenResp struct {
		Token string `json:"token"`
	}
	json.Unmarshal(raw, &tokenResp)
	if tokenResp.Token == "" {
		t.Fatalf("no token in response: %s", raw)
	}

	// Sanity: readable pre-revocation.
	resp, _ = do(t, "GET", srv.URL+"/api/public/planners/"+tokenResp.Token, "", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("pre-revoke public read: got %d, want 200", resp.StatusCode)
	}

	// Owner revokes the token.
	resp, raw = do(t, "POST", fmt.Sprintf("%s/api/planners/%d/share-tokens/%s/revoke", srv.URL, plannerID, tokenResp.Token), ownerTok, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("revoke: %d %s", resp.StatusCode, raw)
	}

	// Now the public endpoint must treat it as not found.
	resp, raw = do(t, "GET", srv.URL+"/api/public/planners/"+tokenResp.Token, "", nil)
	if resp.StatusCode != 404 {
		t.Errorf("revoked token public read: got %d, want 404 (body: %s)", resp.StatusCode, raw)
	}
}
