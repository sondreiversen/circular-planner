package importing_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
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

// minimalICS is a small, valid iCalendar payload with a single all-day event,
// enough for github.com/arran4/golang-ical to parse successfully.
const minimalICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//circular-planner-tests//EN
BEGIN:VEVENT
UID:import-test-1@example.com
DTSTAMP:20260101T000000Z
DTSTART:20260301T000000Z
DTEND:20260302T000000Z
SUMMARY:Launch Day
DESCRIPTION:Kickoff event
END:VEVENT
END:VCALENDAR
`

// multipartImportRequest builds a POST request against the import endpoint.
// If fileContent is nil, the "file" form field is omitted entirely (used to
// exercise the "no file uploaded" malformed-payload case).
func multipartImportRequest(t *testing.T, url, token, filename string, fileContent []byte, laneID string) (*http.Response, []byte) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)

	if fileContent != nil {
		fw, err := mw.CreateFormFile("file", filename)
		if err != nil {
			t.Fatalf("create form file: %v", err)
		}
		if _, err := fw.Write(fileContent); err != nil {
			t.Fatalf("write file content: %v", err)
		}
	}
	if laneID != "" {
		if err := mw.WriteField("laneId", laneID); err != nil {
			t.Fatalf("write laneId field: %v", err)
		}
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}

	req, err := http.NewRequest("POST", url, &buf)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, raw
}

// TestImportICSHappyPath verifies that an edit-capable user can import a
// minimal valid .ics file and that the events land as activities.
func TestImportICSHappyPath(t *testing.T) {
	srv, _, _ := testutil.NewServer(t)

	ownerTok := register(t, srv.URL, "import-owner", "import-owner@example.com", "hunter2hunter2")
	plannerID := createPlanner(t, srv.URL, ownerTok, "Import Planner")

	url := fmt.Sprintf("%s/api/planners/%d/import", srv.URL, plannerID)
	resp, raw := multipartImportRequest(t, url, ownerTok, "events.ics", []byte(minimalICS), "")
	if resp.StatusCode != 200 {
		t.Fatalf("import happy path: %d %s", resp.StatusCode, raw)
	}

	var out struct {
		Imported int    `json:"imported"`
		LaneID   string `json:"laneId"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal import response: %v (body: %s)", err, raw)
	}
	if out.Imported != 1 {
		t.Errorf("imported count: got %d, want 1", out.Imported)
	}
	if out.LaneID == "" {
		t.Error("expected a laneId to be created for the import")
	}

	// Verify the activity actually shows up in the planner.
	resp, raw = do(t, "GET", fmt.Sprintf("%s/api/planners/%d", srv.URL, plannerID), ownerTok, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("get planner after import: %d %s", resp.StatusCode, raw)
	}
	var getResp struct {
		Data struct {
			Lanes []struct {
				ID         string `json:"id"`
				Activities []struct {
					Title     string `json:"title"`
					StartDate string `json:"startDate"`
					EndDate   string `json:"endDate"`
				} `json:"activities"`
			} `json:"lanes"`
		} `json:"data"`
	}
	json.Unmarshal(raw, &getResp)
	var foundTitle string
	for _, l := range getResp.Data.Lanes {
		if l.ID != out.LaneID {
			continue
		}
		for _, a := range l.Activities {
			if a.Title == "Launch Day" {
				foundTitle = a.Title
			}
		}
	}
	if foundTitle != "Launch Day" {
		t.Errorf("imported activity not found in planner data: %+v", getResp.Data.Lanes)
	}
}

// TestImportMalformedPayloadRejected verifies that a request missing the
// required "file" form field is rejected with 400 rather than crashing or
// silently no-oping.
func TestImportMalformedPayloadRejected(t *testing.T) {
	srv, _, _ := testutil.NewServer(t)

	ownerTok := register(t, srv.URL, "import-owner2", "import-owner2@example.com", "hunter2hunter2")
	plannerID := createPlanner(t, srv.URL, ownerTok, "Malformed Import Planner")

	url := fmt.Sprintf("%s/api/planners/%d/import", srv.URL, plannerID)

	// No "file" field at all.
	resp, raw := multipartImportRequest(t, url, ownerTok, "", nil, "")
	if resp.StatusCode != 400 {
		t.Errorf("missing file field: got %d, want 400 (body: %s)", resp.StatusCode, raw)
	}

	// Unsupported file extension.
	resp, raw = multipartImportRequest(t, url, ownerTok, "events.txt", []byte("not a calendar"), "")
	if resp.StatusCode != 400 {
		t.Errorf("unsupported extension: got %d, want 400 (body: %s)", resp.StatusCode, raw)
	}
}

// TestImportRequiresEditPermission verifies that a user who only has view
// access (or no access) to the planner cannot import events into it.
func TestImportRequiresEditPermission(t *testing.T) {
	srv, _, _ := testutil.NewServer(t)

	ownerTok := register(t, srv.URL, "import-owner3", "import-owner3@example.com", "hunter2hunter2")
	viewerTok := register(t, srv.URL, "import-viewer3", "import-viewer3@example.com", "hunter2hunter2")
	strangerTok := register(t, srv.URL, "import-stranger3", "import-stranger3@example.com", "hunter2hunter2")
	plannerID := createPlanner(t, srv.URL, ownerTok, "Restricted Import Planner")

	resp, raw := do(t, "POST", fmt.Sprintf("%s/api/planners/%d/shares", srv.URL, plannerID), ownerTok,
		map[string]any{"email": "import-viewer3@example.com", "permission": "view"})
	if resp.StatusCode != 200 && resp.StatusCode != 201 {
		t.Fatalf("share view: %d %s", resp.StatusCode, raw)
	}

	url := fmt.Sprintf("%s/api/planners/%d/import", srv.URL, plannerID)

	// View-only sharee is forbidden.
	resp, raw = multipartImportRequest(t, url, viewerTok, "events.ics", []byte(minimalICS), "")
	if resp.StatusCode != 403 {
		t.Errorf("view-only import: got %d, want 403 (body: %s)", resp.StatusCode, raw)
	}

	// A stranger with no access at all is forbidden (or not found).
	resp, raw = multipartImportRequest(t, url, strangerTok, "events.ics", []byte(minimalICS), "")
	if resp.StatusCode != 403 && resp.StatusCode != 404 {
		t.Errorf("stranger import: got %d, want 403 or 404 (body: %s)", resp.StatusCode, raw)
	}
}
