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

// sharePlanner grants edit access to editEmail via the share API.
func sharePlanner(t *testing.T, base string, ownerTok string, plannerID int, editEmail string) {
	t.Helper()
	resp, raw := do(t, "POST", fmt.Sprintf("%s/api/planners/%d/shares", base, plannerID), ownerTok,
		map[string]any{"email": editEmail, "permission": "edit"})
	if resp.StatusCode != 201 && resp.StatusCode != 200 {
		t.Fatalf("share: %d %s", resp.StatusCode, raw)
	}
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

// TestR1EditUserCannotDestroyContent verifies that a user with edit permission
// cannot wipe lanes/activities, but can make additive-only changes.
func TestR1EditUserCannotDestroyContent(t *testing.T) {
	srv, _, _ := testutil.NewServer(t)

	ownerTok := registerHelper(t, srv.URL, "owner1", "owner1@example.com", "hunter2hunter2")
	editTok := registerHelper(t, srv.URL, "editor1", "editor1@example.com", "hunter2hunter2")

	// Owner creates planner
	resp, raw := do(t, "POST", srv.URL+"/api/planners", ownerTok,
		map[string]string{"title": "Shared", "startDate": "2026-01-01", "endDate": "2026-12-31"})
	if resp.StatusCode != 201 {
		t.Fatalf("create: %d %s", resp.StatusCode, raw)
	}
	var created struct{ ID int }
	json.Unmarshal(raw, &created)

	// Add a lane via PUT (as owner)
	resp, raw = do(t, "PUT", fmt.Sprintf("%s/api/planners/%d", srv.URL, created.ID), ownerTok, map[string]any{
		"lanes": []any{
			map[string]any{"id": "lane1", "name": "Lane One", "order": 1, "color": "#ff0000", "activities": []any{}},
		},
	})
	if resp.StatusCode != 200 {
		t.Fatalf("owner PUT with lane: %d %s", resp.StatusCode, raw)
	}

	// Share with editor1 using email
	sharePlanner(t, srv.URL, ownerTok, created.ID, "editor1@example.com")

	// Editor PUTs empty lanes → 403 (would delete lane1)
	resp, raw = do(t, "PUT", fmt.Sprintf("%s/api/planners/%d", srv.URL, created.ID), editTok, map[string]any{
		"lanes": []any{},
	})
	if resp.StatusCode != 403 {
		t.Errorf("edit wipe: got %d, want 403 (body: %s)", resp.StatusCode, raw)
	}

	// Editor adds a new lane without removing lane1 → 200
	resp, raw = do(t, "PUT", fmt.Sprintf("%s/api/planners/%d", srv.URL, created.ID), editTok, map[string]any{
		"lanes": []any{
			map[string]any{"id": "lane1", "name": "Lane One", "order": 1, "color": "#ff0000", "activities": []any{}},
			map[string]any{"id": "lane2", "name": "Lane Two", "order": 2, "color": "#00ff00", "activities": []any{}},
		},
	})
	if resp.StatusCode != 200 {
		t.Errorf("edit additive: got %d, want 200 (body: %s)", resp.StatusCode, raw)
	}
}

// TestActivityRecurrence verifies that recurrence fields round-trip through PUT→GET correctly.
func TestActivityRecurrence(t *testing.T) {
	srv, _, _ := testutil.NewServer(t)
	tok := registerHelper(t, srv.URL, "recurrer", "recurrer@example.com", "hunter2hunter2")

	resp, raw := do(t, "POST", srv.URL+"/api/planners", tok,
		map[string]string{"title": "RecurTest", "startDate": "2026-01-01", "endDate": "2026-12-31"})
	if resp.StatusCode != 201 {
		t.Fatalf("create: %d %s", resp.StatusCode, raw)
	}
	var created struct{ ID int }
	json.Unmarshal(raw, &created)

	// PUT with weekly recurrence
	weeklyActivity := map[string]any{
		"id": "act-weekly", "laneId": "lane1", "title": "Weekly Meeting",
		"description": "", "startDate": "2026-01-05", "endDate": "2026-01-05",
		"color": "#E53935", "label": "",
		"recurrence": map[string]any{
			"type":     "weekly",
			"interval": 1,
			"weekdays": []int{1, 3, 5},
			"until":    "2026-12-31",
		},
	}
	dailyActivity := map[string]any{
		"id": "act-daily", "laneId": "lane1", "title": "Daily Standup",
		"description": "", "startDate": "2026-01-01", "endDate": "2026-01-01",
		"color": "#43A047", "label": "",
		"recurrence": map[string]any{
			"type":     "daily",
			"interval": 2,
		},
	}
	noRecurActivity := map[string]any{
		"id": "act-norecur", "laneId": "lane1", "title": "One-off Event",
		"description": "", "startDate": "2026-03-15", "endDate": "2026-03-20",
		"color": "#1E88E5", "label": "",
	}

	resp, raw = do(t, "PUT", fmt.Sprintf("%s/api/planners/%d", srv.URL, created.ID), tok, map[string]any{
		"lanes": []any{
			map[string]any{
				"id": "lane1", "name": "Work", "order": 1, "color": "#ccc",
				"activities": []any{weeklyActivity, dailyActivity, noRecurActivity},
			},
		},
	})
	if resp.StatusCode != 200 {
		t.Fatalf("PUT with recurrence: %d %s", resp.StatusCode, raw)
	}

	// GET and verify round-trip
	resp, raw = do(t, "GET", fmt.Sprintf("%s/api/planners/%d", srv.URL, created.ID), tok, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("GET after PUT: %d %s", resp.StatusCode, raw)
	}

	var getResp struct {
		Data struct {
			Lanes []struct {
				Activities []struct {
					ID         string `json:"id"`
					Title      string `json:"title"`
					Recurrence *struct {
						Type     string  `json:"type"`
						Interval int     `json:"interval"`
						Weekdays []int   `json:"weekdays"`
						Until    *string `json:"until"`
					} `json:"recurrence"`
				} `json:"activities"`
			} `json:"lanes"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &getResp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(getResp.Data.Lanes) == 0 {
		t.Fatal("no lanes in response")
	}
	acts := getResp.Data.Lanes[0].Activities
	byID := make(map[string]int)
	for i, a := range acts {
		byID[a.ID] = i
	}

	// Check weekly recurrence
	wi, ok := byID["act-weekly"]
	if !ok {
		t.Fatal("act-weekly not found")
	}
	wa := acts[wi]
	if wa.Recurrence == nil {
		t.Fatal("act-weekly: expected recurrence, got nil")
	}
	if wa.Recurrence.Type != "weekly" {
		t.Errorf("act-weekly type: got %q, want %q", wa.Recurrence.Type, "weekly")
	}
	if wa.Recurrence.Interval != 1 {
		t.Errorf("act-weekly interval: got %d, want 1", wa.Recurrence.Interval)
	}
	if len(wa.Recurrence.Weekdays) != 3 || wa.Recurrence.Weekdays[0] != 1 || wa.Recurrence.Weekdays[1] != 3 || wa.Recurrence.Weekdays[2] != 5 {
		t.Errorf("act-weekly weekdays: got %v, want [1 3 5]", wa.Recurrence.Weekdays)
	}
	if wa.Recurrence.Until == nil || *wa.Recurrence.Until != "2026-12-31" {
		t.Errorf("act-weekly until: got %v, want 2026-12-31", wa.Recurrence.Until)
	}

	// Check daily recurrence
	di, ok := byID["act-daily"]
	if !ok {
		t.Fatal("act-daily not found")
	}
	da := acts[di]
	if da.Recurrence == nil {
		t.Fatal("act-daily: expected recurrence, got nil")
	}
	if da.Recurrence.Type != "daily" {
		t.Errorf("act-daily type: got %q, want %q", da.Recurrence.Type, "daily")
	}
	if da.Recurrence.Interval != 2 {
		t.Errorf("act-daily interval: got %d, want 2", da.Recurrence.Interval)
	}
	if da.Recurrence.Until != nil {
		t.Errorf("act-daily until: got %v, want nil", da.Recurrence.Until)
	}

	// Check non-recurring
	ni, ok := byID["act-norecur"]
	if !ok {
		t.Fatal("act-norecur not found")
	}
	if acts[ni].Recurrence != nil {
		t.Errorf("act-norecur: expected nil recurrence, got %+v", acts[ni].Recurrence)
	}
}

// TestActivityRecurrenceValidation verifies server-side validation for recurrence.
func TestActivityRecurrenceValidation(t *testing.T) {
	srv, _, _ := testutil.NewServer(t)
	tok := registerHelper(t, srv.URL, "recvalid", "recvalid@example.com", "hunter2hunter2")

	resp, raw := do(t, "POST", srv.URL+"/api/planners", tok,
		map[string]string{"title": "ValTest", "startDate": "2026-01-01", "endDate": "2026-12-31"})
	if resp.StatusCode != 201 {
		t.Fatalf("create: %d %s", resp.StatusCode, raw)
	}
	var created struct{ ID int }
	json.Unmarshal(raw, &created)

	base := map[string]any{
		"lanes": []any{
			map[string]any{
				"id": "lane1", "name": "L", "order": 1, "color": "#ccc",
				"activities": []any{},
			},
		},
	}

	actWith := func(rec map[string]any) map[string]any {
		body := make(map[string]any)
		for k, v := range base {
			body[k] = v
		}
		act := map[string]any{
			"id": "act1", "laneId": "lane1", "title": "X",
			"description": "", "startDate": "2026-01-01", "endDate": "2026-01-01",
			"color": "#000", "label": "", "recurrence": rec,
		}
		body["lanes"] = []any{
			map[string]any{
				"id": "lane1", "name": "L", "order": 1, "color": "#ccc",
				"activities": []any{act},
			},
		}
		return body
	}

	// Invalid type
	resp, raw = do(t, "PUT", fmt.Sprintf("%s/api/planners/%d", srv.URL, created.ID), tok,
		actWith(map[string]any{"type": "monthly", "interval": 1}))
	if resp.StatusCode != 400 {
		t.Errorf("invalid type: got %d, want 400 (body: %s)", resp.StatusCode, raw)
	}

	// Interval < 1
	resp, raw = do(t, "PUT", fmt.Sprintf("%s/api/planners/%d", srv.URL, created.ID), tok,
		actWith(map[string]any{"type": "daily", "interval": 0}))
	if resp.StatusCode != 400 {
		t.Errorf("interval 0: got %d, want 400 (body: %s)", resp.StatusCode, raw)
	}

	// Weekly with empty weekdays
	resp, raw = do(t, "PUT", fmt.Sprintf("%s/api/planners/%d", srv.URL, created.ID), tok,
		actWith(map[string]any{"type": "weekly", "interval": 1, "weekdays": []int{}}))
	if resp.StatusCode != 400 {
		t.Errorf("weekly empty weekdays: got %d, want 400 (body: %s)", resp.StatusCode, raw)
	}
}

// TestR4UnknownLaneID verifies that an activity referencing a non-existent lane returns 400.
func TestR4UnknownLaneID(t *testing.T) {
	srv, _, _ := testutil.NewServer(t)
	tok := registerHelper(t, srv.URL, "owner2", "owner2@example.com", "hunter2hunter2")

	resp, raw := do(t, "POST", srv.URL+"/api/planners", tok,
		map[string]string{"title": "P", "startDate": "2026-01-01", "endDate": "2026-12-31"})
	if resp.StatusCode != 201 {
		t.Fatalf("create: %d %s", resp.StatusCode, raw)
	}
	var created struct{ ID int }
	json.Unmarshal(raw, &created)

	// Activity references lane "ghost" which is not in body.Lanes → 400
	resp, raw = do(t, "PUT", fmt.Sprintf("%s/api/planners/%d", srv.URL, created.ID), tok, map[string]any{
		"lanes": []any{
			map[string]any{
				"id": "lane1", "name": "L", "order": 1, "color": "#000",
				"activities": []any{
					map[string]any{
						"id": "act1", "laneId": "ghost", "title": "X",
						"description": "", "startDate": "2026-01-01", "endDate": "2026-01-31",
						"color": "#000", "label": "",
					},
				},
			},
		},
	})
	if resp.StatusCode != 400 {
		t.Errorf("unknown laneId: got %d, want 400 (body: %s)", resp.StatusCode, raw)
	}
}
