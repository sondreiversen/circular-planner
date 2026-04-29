package groups_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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
	if err := json.Unmarshal(raw, &out); err != nil || out.Token == "" {
		t.Fatalf("register parse: %v body=%s", err, raw)
	}
	return out.Token
}

func createGroup(t *testing.T, base, token, name string) int {
	t.Helper()
	resp, raw := postJSON(t, base+"/api/groups",
		map[string]string{"name": name}, token)
	if resp.StatusCode != 201 {
		t.Fatalf("createGroup: status=%d body=%s", resp.StatusCode, raw)
	}
	var out struct{ ID int `json:"id"` }
	_ = json.Unmarshal(raw, &out)
	return out.ID
}

func memberCount(t *testing.T, base, token string, groupID int) int {
	t.Helper()
	req, _ := http.NewRequest("GET", base+"/api/groups/"+itoa(groupID), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET group: %v", err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	var out struct {
		Members []struct{ UserID int `json:"user_id"` } `json:"members"`
	}
	_ = json.Unmarshal(raw, &out)
	return len(out.Members)
}

func itoa(i int) string {
	return fmt.Sprintf("%d", i)
}

func TestAddMemberMulti(t *testing.T) {
	srv, _, database := testutil.NewServer(t)
	base := srv.URL

	adminToken := register(t, base, "owner", "owner@example.com", "password1234")
	groupID := createGroup(t, base, adminToken, "Test Group")

	// Create two users to add
	register(t, base, "userA", "usera@example.com", "password1234")
	register(t, base, "userB", "userb@example.com", "password1234")

	// Look up their IDs
	var idA, idB int
	_ = database.QueryRowContext(t.Context(),
		database.Rebind("SELECT id FROM users WHERE username = ?"), "userA",
	).Scan(&idA)
	_ = database.QueryRowContext(t.Context(),
		database.Rebind("SELECT id FROM users WHERE username = ?"), "userB",
	).Scan(&idB)

	// Add both in one call
	resp, raw := postJSON(t, base+"/api/groups/"+itoa(groupID)+"/members",
		map[string]any{"user_ids": []int{idA, idB}, "role": "member"}, adminToken)
	if resp.StatusCode != 200 {
		t.Fatalf("multi-add: status=%d body=%s", resp.StatusCode, raw)
	}

	// Should now have 3 members (owner + A + B)
	if n := memberCount(t, base, adminToken, groupID); n != 3 {
		t.Errorf("member count: got %d, want 3", n)
	}
}

func TestAddMemberInvalidID(t *testing.T) {
	srv, _, _ := testutil.NewServer(t)
	base := srv.URL

	adminToken := register(t, base, "owner2", "owner2@example.com", "password1234")
	groupID := createGroup(t, base, adminToken, "Test Group 2")

	register(t, base, "validUser", "valid@example.com", "password1234")
	var validID int
	// Use a non-existent ID for the invalid one
	invalidID := 99999

	// Get valid user ID from the server
	req, _ := http.NewRequest("GET", base+"/api/users?q=valid", nil)
	req.Header.Set("Authorization", "Bearer "+adminToken)
	resp, _ := http.DefaultClient.Do(req)
	var users []struct{ ID int `json:"id"` }
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	_ = json.Unmarshal(raw, &users)
	if len(users) > 0 {
		validID = users[0].ID
	}

	beforeCount := memberCount(t, base, adminToken, groupID)

	// Mix valid + invalid ID → should return 404
	resp, raw = postJSON(t, base+"/api/groups/"+itoa(groupID)+"/members",
		map[string]any{"user_ids": []int{validID, invalidID}, "role": "member"}, adminToken)
	if resp.StatusCode != 404 {
		t.Errorf("mixed valid+invalid: got %d, want 404 body=%s", resp.StatusCode, raw)
	}

	// Member count should be unchanged (nothing was inserted)
	if n := memberCount(t, base, adminToken, groupID); n != beforeCount {
		t.Errorf("member count changed: got %d, want %d", n, beforeCount)
	}
}

func TestAddMemberEmptyIDs(t *testing.T) {
	srv, _, _ := testutil.NewServer(t)
	base := srv.URL

	adminToken := register(t, base, "owner3", "owner3@example.com", "password1234")
	groupID := createGroup(t, base, adminToken, "Test Group 3")

	resp, raw := postJSON(t, base+"/api/groups/"+itoa(groupID)+"/members",
		map[string]any{"user_ids": []int{}, "role": "member"}, adminToken)
	if resp.StatusCode != 400 {
		t.Errorf("empty user_ids: got %d, want 400 body=%s", resp.StatusCode, raw)
	}
}

func TestAddMemberExistingAndNew(t *testing.T) {
	srv, _, database := testutil.NewServer(t)
	base := srv.URL

	adminToken := register(t, base, "owner4", "owner4@example.com", "password1234")
	groupID := createGroup(t, base, adminToken, "Test Group 4")

	register(t, base, "existingMember", "existing@example.com", "password1234")
	register(t, base, "newMember", "new@example.com", "password1234")

	var existingID, newID int
	_ = database.QueryRowContext(t.Context(),
		database.Rebind("SELECT id FROM users WHERE username = ?"), "existingMember",
	).Scan(&existingID)
	_ = database.QueryRowContext(t.Context(),
		database.Rebind("SELECT id FROM users WHERE username = ?"), "newMember",
	).Scan(&newID)

	// Add existingMember first as "member"
	resp, raw := postJSON(t, base+"/api/groups/"+itoa(groupID)+"/members",
		map[string]any{"user_ids": []int{existingID}, "role": "member"}, adminToken)
	if resp.StatusCode != 200 {
		t.Fatalf("add existing: status=%d body=%s", resp.StatusCode, raw)
	}

	// Now add both (existingMember + newMember) as "admin" in one batch
	resp, raw = postJSON(t, base+"/api/groups/"+itoa(groupID)+"/members",
		map[string]any{"user_ids": []int{existingID, newID}, "role": "admin"}, adminToken)
	if resp.StatusCode != 200 {
		t.Fatalf("batch upsert: status=%d body=%s", resp.StatusCode, raw)
	}

	// Verify both now have role=admin
	var role string
	_ = database.QueryRowContext(t.Context(),
		database.Rebind("SELECT role FROM group_members WHERE group_id = ? AND user_id = ?"),
		groupID, existingID,
	).Scan(&role)
	if role != "admin" {
		t.Errorf("existingMember role: got %q, want admin", role)
	}

	_ = database.QueryRowContext(t.Context(),
		database.Rebind("SELECT role FROM group_members WHERE group_id = ? AND user_id = ?"),
		groupID, newID,
	).Scan(&role)
	if role != "admin" {
		t.Errorf("newMember role: got %q, want admin", role)
	}
}
