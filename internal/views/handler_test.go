package views_test

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

// TestSavedViewCRUD covers the full lifecycle for a user with access to the
// planner: create a saved view, see it via List, then delete it.
func TestSavedViewCRUD(t *testing.T) {
	srv, _, _ := testutil.NewServer(t)

	ownerTok := register(t, srv.URL, "views-owner", "views-owner@example.com", "hunter2hunter2")
	plannerID := createPlanner(t, srv.URL, ownerTok, "Views Planner")

	// List starts empty.
	resp, raw := do(t, "GET", fmt.Sprintf("%s/api/planners/%d/views", srv.URL, plannerID), ownerTok, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("list (empty): %d %s", resp.StatusCode, raw)
	}
	var list []struct {
		ID   int    `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		t.Fatalf("unmarshal empty list: %v (body: %s)", err, raw)
	}
	if len(list) != 0 {
		t.Fatalf("expected empty view list, got %d entries", len(list))
	}

	// Create a saved view.
	resp, raw = do(t, "POST", fmt.Sprintf("%s/api/planners/%d/views", srv.URL, plannerID), ownerTok, map[string]any{
		"name":     "My Filtered View",
		"state":    `{"search":"launch"}`,
		"isShared": false,
	})
	if resp.StatusCode != 201 {
		t.Fatalf("create view: %d %s", resp.StatusCode, raw)
	}
	var created struct {
		ID int64 `json:"id"`
	}
	json.Unmarshal(raw, &created)
	if created.ID == 0 {
		t.Fatalf("create view returned no id: %s", raw)
	}

	// List now contains the view.
	resp, raw = do(t, "GET", fmt.Sprintf("%s/api/planners/%d/views", srv.URL, plannerID), ownerTok, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("list after create: %d %s", resp.StatusCode, raw)
	}
	list = nil
	json.Unmarshal(raw, &list)
	found := false
	for _, v := range list {
		if v.ID == int(created.ID) {
			found = true
			if v.Name != "My Filtered View" {
				t.Errorf("view name: got %q, want %q", v.Name, "My Filtered View")
			}
		}
	}
	if !found {
		t.Fatalf("created view not found in list: %s", raw)
	}

	// Delete the view.
	resp, raw = do(t, "DELETE", fmt.Sprintf("%s/api/planners/%d/views/%d", srv.URL, plannerID, created.ID), ownerTok, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("delete view: %d %s", resp.StatusCode, raw)
	}

	// List is empty again.
	resp, raw = do(t, "GET", fmt.Sprintf("%s/api/planners/%d/views", srv.URL, plannerID), ownerTok, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("list after delete: %d %s", resp.StatusCode, raw)
	}
	list = nil
	json.Unmarshal(raw, &list)
	for _, v := range list {
		if v.ID == int(created.ID) {
			t.Errorf("deleted view still present: %+v", v)
		}
	}
}

// TestSavedViewRequiresAccess verifies that a user with no access at all to
// the planner is denied on every saved-view route (list/create/delete).
func TestSavedViewRequiresAccess(t *testing.T) {
	srv, _, _ := testutil.NewServer(t)

	ownerTok := register(t, srv.URL, "views-owner2", "views-owner2@example.com", "hunter2hunter2")
	strangerTok := register(t, srv.URL, "views-stranger2", "views-stranger2@example.com", "hunter2hunter2")
	plannerID := createPlanner(t, srv.URL, ownerTok, "Private Views Planner")

	// Owner creates a view first so there's something a stranger might try to touch.
	resp, raw := do(t, "POST", fmt.Sprintf("%s/api/planners/%d/views", srv.URL, plannerID), ownerTok, map[string]any{
		"name":  "Owner View",
		"state": `{}`,
	})
	if resp.StatusCode != 201 {
		t.Fatalf("owner create view: %d %s", resp.StatusCode, raw)
	}
	var created struct {
		ID int64 `json:"id"`
	}
	json.Unmarshal(raw, &created)

	// Stranger cannot list.
	resp, raw = do(t, "GET", fmt.Sprintf("%s/api/planners/%d/views", srv.URL, plannerID), strangerTok, nil)
	if resp.StatusCode != 403 && resp.StatusCode != 404 {
		t.Errorf("stranger list: got %d, want 403 or 404 (body: %s)", resp.StatusCode, raw)
	}

	// Stranger cannot create.
	resp, raw = do(t, "POST", fmt.Sprintf("%s/api/planners/%d/views", srv.URL, plannerID), strangerTok, map[string]any{
		"name":  "Intruder View",
		"state": `{}`,
	})
	if resp.StatusCode != 403 && resp.StatusCode != 404 {
		t.Errorf("stranger create: got %d, want 403 or 404 (body: %s)", resp.StatusCode, raw)
	}

	// Stranger cannot delete the owner's view.
	resp, raw = do(t, "DELETE", fmt.Sprintf("%s/api/planners/%d/views/%d", srv.URL, plannerID, created.ID), strangerTok, nil)
	if resp.StatusCode != 403 && resp.StatusCode != 404 {
		t.Errorf("stranger delete: got %d, want 403 or 404 (body: %s)", resp.StatusCode, raw)
	}
}
