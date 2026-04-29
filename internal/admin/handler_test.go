package admin_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
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

func getUserID(t *testing.T, base, tok string) int {
	t.Helper()
	resp, raw := do(t, "GET", base+"/api/auth/me", tok, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("me: %d %s", resp.StatusCode, raw)
	}
	var out struct {
		User struct{ ID int }
	}
	json.Unmarshal(raw, &out)
	return out.User.ID
}

// TestR2LastAdminDemoteRace verifies that concurrent demote requests leave at least one admin.
func TestR2LastAdminDemoteRace(t *testing.T) {
	srv, _, database := testutil.NewServer(t)
	ctx := context.Background()

	tok1 := registerHelper(t, srv.URL, "admin1", "admin1@example.com", "hunter2hunter2")
	tok2 := registerHelper(t, srv.URL, "admin2", "admin2@example.com", "hunter2hunter2")
	id1 := getUserID(t, srv.URL, tok1)
	id2 := getUserID(t, srv.URL, tok2)

	// Make both users admins directly in the DB.
	if _, err := database.ExecContext(ctx,
		database.Rebind("UPDATE users SET is_admin = 1 WHERE id IN (?, ?)"), id1, id2,
	); err != nil {
		t.Fatalf("make admins: %v", err)
	}

	// Both try to demote each other concurrently; at most one should succeed.
	var wg sync.WaitGroup
	results := make([]int, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		resp, _ := do(t, "PATCH", fmt.Sprintf("%s/api/admin/users/%d", srv.URL, id2), tok1, map[string]any{"is_admin": false})
		results[0] = resp.StatusCode
	}()
	go func() {
		defer wg.Done()
		resp, _ := do(t, "PATCH", fmt.Sprintf("%s/api/admin/users/%d", srv.URL, id1), tok2, map[string]any{"is_admin": false})
		results[1] = resp.StatusCode
	}()
	wg.Wait()

	success := 0
	for _, code := range results {
		if code == 200 {
			success++
		}
	}
	if success > 1 {
		t.Errorf("both demotes succeeded; final admin count would be 0. results: %v", results)
	}

	var count int
	if err := database.QueryRowContext(ctx, "SELECT COUNT(*) FROM users WHERE is_admin = 1").Scan(&count); err != nil {
		t.Fatalf("count admins: %v", err)
	}
	if count < 1 {
		t.Errorf("no admins remain after concurrent demote race")
	}
}

// TestR3DeleteUserWithPlanners verifies 409 when deleting a user who owns planners,
// and 200 after their planners are removed.
func TestR3DeleteUserWithPlanners(t *testing.T) {
	srv, _, database := testutil.NewServer(t)
	ctx := context.Background()

	adminTok := registerHelper(t, srv.URL, "superadmin", "superadmin@example.com", "hunter2hunter2")
	targetTok := registerHelper(t, srv.URL, "victim", "victim@example.com", "hunter2hunter2")
	adminID := getUserID(t, srv.URL, adminTok)
	targetID := getUserID(t, srv.URL, targetTok)

	// Elevate superadmin; target doesn't need to be admin.
	if _, err := database.ExecContext(ctx,
		database.Rebind("UPDATE users SET is_admin = 1 WHERE id = ?"), adminID,
	); err != nil {
		t.Fatalf("make admin: %v", err)
	}

	// Target creates a planner.
	resp, raw := do(t, "POST", srv.URL+"/api/planners", targetTok,
		map[string]string{"title": "Owned", "startDate": "2026-01-01", "endDate": "2026-12-31"})
	if resp.StatusCode != 201 {
		t.Fatalf("create planner: %d %s", resp.StatusCode, raw)
	}
	var created struct{ ID int }
	json.Unmarshal(raw, &created)

	// Admin tries to delete target → 409.
	resp, raw = do(t, "DELETE", fmt.Sprintf("%s/api/admin/users/%d", srv.URL, targetID), adminTok, nil)
	if resp.StatusCode != 409 {
		t.Errorf("delete with planner: got %d, want 409 (body: %s)", resp.StatusCode, raw)
	}
	var errBody struct {
		OwnedPlanners int `json:"owned_planners"`
	}
	json.Unmarshal(raw, &errBody)
	if errBody.OwnedPlanners != 1 {
		t.Errorf("owned_planners: got %d, want 1", errBody.OwnedPlanners)
	}

	// Remove the planner as the target user.
	resp, raw = do(t, "DELETE", fmt.Sprintf("%s/api/planners/%d", srv.URL, created.ID), targetTok, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("delete planner: %d %s", resp.StatusCode, raw)
	}

	// Now the delete should succeed.
	resp, raw = do(t, "DELETE", fmt.Sprintf("%s/api/admin/users/%d", srv.URL, targetID), adminTok, nil)
	if resp.StatusCode != 200 {
		t.Errorf("delete after planner removed: got %d, want 200 (body: %s)", resp.StatusCode, raw)
	}
}
