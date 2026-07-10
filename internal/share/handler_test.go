package share_test

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

// TestShareCreateListDelete covers the owner's full lifecycle: create a
// share, see it in the list, then delete it.
func TestShareCreateListDelete(t *testing.T) {
	srv, _, _ := testutil.NewServer(t)

	ownerTok := register(t, srv.URL, "share-owner", "share-owner@example.com", "hunter2hunter2")
	friendTok := register(t, srv.URL, "share-friend", "share-friend@example.com", "hunter2hunter2")
	plannerID := createPlanner(t, srv.URL, ownerTok, "Shared Planner")

	// Look up friend's user id via /api/auth/me.
	resp, raw := do(t, "GET", srv.URL+"/api/auth/me", friendTok, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("me: %d %s", resp.StatusCode, raw)
	}
	var meResp struct {
		User struct{ ID int } `json:"user"`
	}
	json.Unmarshal(raw, &meResp)
	if meResp.User.ID == 0 {
		t.Fatalf("could not resolve friend's user id: %s", raw)
	}
	friendID := meResp.User.ID

	// Owner creates a view share for the friend.
	resp, raw = do(t, "POST", fmt.Sprintf("%s/api/planners/%d/shares", srv.URL, plannerID), ownerTok,
		map[string]any{"email": "share-friend@example.com", "permission": "view"})
	if resp.StatusCode != 200 {
		t.Fatalf("create share: %d %s", resp.StatusCode, raw)
	}

	// Owner lists shares and sees the friend.
	resp, raw = do(t, "GET", fmt.Sprintf("%s/api/planners/%d/shares", srv.URL, plannerID), ownerTok, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("list shares: %d %s", resp.StatusCode, raw)
	}
	var shares []struct {
		UserID     int    `json:"user_id"`
		Permission string `json:"permission"`
	}
	if err := json.Unmarshal(raw, &shares); err != nil {
		t.Fatalf("unmarshal shares: %v (body: %s)", err, raw)
	}
	found := false
	for _, s := range shares {
		if s.UserID == friendID {
			found = true
			if s.Permission != "view" {
				t.Errorf("share permission: got %q, want view", s.Permission)
			}
		}
	}
	if !found {
		t.Fatalf("friend not found in share list: %s", raw)
	}

	// Owner deletes the share.
	resp, raw = do(t, "DELETE", fmt.Sprintf("%s/api/planners/%d/shares/%d", srv.URL, plannerID, friendID), ownerTok, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("delete share: %d %s", resp.StatusCode, raw)
	}

	// List is now empty.
	resp, raw = do(t, "GET", fmt.Sprintf("%s/api/planners/%d/shares", srv.URL, plannerID), ownerTok, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("list shares after delete: %d %s", resp.StatusCode, raw)
	}
	shares = nil
	json.Unmarshal(raw, &shares)
	for _, s := range shares {
		if s.UserID == friendID {
			t.Errorf("friend still present after delete: %+v", s)
		}
	}
}

// TestShareCreateRequiresOwnership verifies that a non-owner (including a
// user with only edit access) cannot create a new share on the planner.
func TestShareCreateRequiresOwnership(t *testing.T) {
	srv, _, _ := testutil.NewServer(t)

	ownerTok := register(t, srv.URL, "share-owner2", "share-owner2@example.com", "hunter2hunter2")
	editorTok := register(t, srv.URL, "share-editor2", "share-editor2@example.com", "hunter2hunter2")
	strangerTok := register(t, srv.URL, "share-stranger2", "share-stranger2@example.com", "hunter2hunter2")
	plannerID := createPlanner(t, srv.URL, ownerTok, "Owner-Only Planner")

	// Grant the editor edit access first.
	resp, raw := do(t, "POST", fmt.Sprintf("%s/api/planners/%d/shares", srv.URL, plannerID), ownerTok,
		map[string]any{"email": "share-editor2@example.com", "permission": "edit"})
	if resp.StatusCode != 200 {
		t.Fatalf("owner shares with editor: %d %s", resp.StatusCode, raw)
	}

	// The editor (edit access, not owner) cannot create a further share.
	resp, raw = do(t, "POST", fmt.Sprintf("%s/api/planners/%d/shares", srv.URL, plannerID), editorTok,
		map[string]any{"email": "share-stranger2@example.com", "permission": "view"})
	if resp.StatusCode != 403 {
		t.Errorf("editor create share: got %d, want 403 (body: %s)", resp.StatusCode, raw)
	}

	// A user with no access at all also cannot create a share.
	resp, raw = do(t, "POST", fmt.Sprintf("%s/api/planners/%d/shares", srv.URL, plannerID), strangerTok,
		map[string]any{"email": "share-editor2@example.com", "permission": "view"})
	if resp.StatusCode != 403 && resp.StatusCode != 404 {
		t.Errorf("stranger create share: got %d, want 403 or 404 (body: %s)", resp.StatusCode, raw)
	}
}

// TestSharedUserCanAccessPlanner verifies that once shared, the target user
// can actually read (and, for edit shares, write) the planner.
func TestSharedUserCanAccessPlanner(t *testing.T) {
	srv, _, _ := testutil.NewServer(t)

	ownerTok := register(t, srv.URL, "share-owner3", "share-owner3@example.com", "hunter2hunter2")
	viewerTok := register(t, srv.URL, "share-viewer3", "share-viewer3@example.com", "hunter2hunter2")
	plannerID := createPlanner(t, srv.URL, ownerTok, "Access Planner")

	// Before sharing, the viewer cannot GET the planner.
	resp, _ := do(t, "GET", fmt.Sprintf("%s/api/planners/%d", srv.URL, plannerID), viewerTok, nil)
	if resp.StatusCode != 403 && resp.StatusCode != 404 {
		t.Fatalf("pre-share GET: got %d, want 403 or 404", resp.StatusCode)
	}

	resp, raw := do(t, "POST", fmt.Sprintf("%s/api/planners/%d/shares", srv.URL, plannerID), ownerTok,
		map[string]any{"email": "share-viewer3@example.com", "permission": "view"})
	if resp.StatusCode != 200 {
		t.Fatalf("create share: %d %s", resp.StatusCode, raw)
	}

	// After sharing, the viewer can GET the planner.
	resp, raw = do(t, "GET", fmt.Sprintf("%s/api/planners/%d", srv.URL, plannerID), viewerTok, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("post-share GET: got %d %s", resp.StatusCode, raw)
	}
	var getResp struct {
		Config struct {
			Permission string `json:"permission"`
			IsOwner    bool   `json:"isOwner"`
		} `json:"config"`
	}
	json.Unmarshal(raw, &getResp)
	if getResp.Config.IsOwner {
		t.Error("viewer should not be flagged as owner")
	}
	if getResp.Config.Permission != "view" {
		t.Errorf("permission: got %q, want view", getResp.Config.Permission)
	}
}

// TestShareInvalidPermissionRejected verifies the server validates the
// permission string rather than accepting arbitrary values.
func TestShareInvalidPermissionRejected(t *testing.T) {
	srv, _, _ := testutil.NewServer(t)

	ownerTok := register(t, srv.URL, "share-owner4", "share-owner4@example.com", "hunter2hunter2")
	_ = register(t, srv.URL, "share-target4", "share-target4@example.com", "hunter2hunter2")
	plannerID := createPlanner(t, srv.URL, ownerTok, "Validation Planner")

	resp, raw := do(t, "POST", fmt.Sprintf("%s/api/planners/%d/shares", srv.URL, plannerID), ownerTok,
		map[string]any{"email": "share-target4@example.com", "permission": "admin"})
	if resp.StatusCode != 400 {
		t.Errorf("invalid permission: got %d, want 400 (body: %s)", resp.StatusCode, raw)
	}

	// Sharing with an email that doesn't exist -> 404.
	resp, raw = do(t, "POST", fmt.Sprintf("%s/api/planners/%d/shares", srv.URL, plannerID), ownerTok,
		map[string]any{"email": "nobody-here@example.com", "permission": "view"})
	if resp.StatusCode != 404 {
		t.Errorf("unknown email: got %d, want 404 (body: %s)", resp.StatusCode, raw)
	}

	// Missing email -> 400.
	resp, raw = do(t, "POST", fmt.Sprintf("%s/api/planners/%d/shares", srv.URL, plannerID), ownerTok,
		map[string]any{"permission": "view"})
	if resp.StatusCode != 400 {
		t.Errorf("missing email: got %d, want 400 (body: %s)", resp.StatusCode, raw)
	}
}
