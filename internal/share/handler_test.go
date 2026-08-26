package share_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
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

func register(t *testing.T, base, u, e, p string) string {
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

func newPlanner(t *testing.T, base, tok string) int {
	t.Helper()
	resp, raw := do(t, "POST", base+"/api/planners", tok,
		map[string]any{"title": "P", "startDate": "2026-01-01", "endDate": "2026-12-31"})
	if resp.StatusCode != 200 && resp.StatusCode != 201 {
		t.Fatalf("create planner: %d %s", resp.StatusCode, raw)
	}
	var out struct {
		Config struct{ PlannerID int } `json:"config"`
		ID     int                     `json:"id"`
	}
	json.Unmarshal(raw, &out)
	if out.Config.PlannerID != 0 {
		return out.Config.PlannerID
	}
	return out.ID
}

// mintToken POSTs to share-tokens, optionally with a label, and returns the token.
func mintToken(t *testing.T, base, tok string, plannerID int, label string) (string, int) {
	t.Helper()
	body := map[string]any{}
	if label != "" {
		body["label"] = label
	}
	resp, raw := do(t, "POST", fmt.Sprintf("%s/api/planners/%d/share-tokens", base, plannerID), tok, body)
	var out struct{ Token string }
	json.Unmarshal(raw, &out)
	return out.Token, resp.StatusCode
}

type tokenEntry struct {
	Token     string  `json:"token"`
	RevokedAt *string `json:"revoked_at"`
	Label     *string `json:"label"`
}

func listTokens(t *testing.T, base, tok string, plannerID int) []tokenEntry {
	t.Helper()
	resp, raw := do(t, "GET", fmt.Sprintf("%s/api/planners/%d/share-tokens", base, plannerID), tok, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("list tokens: %d %s", resp.StatusCode, raw)
	}
	var out []tokenEntry
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal tokens: %v (%s)", err, raw)
	}
	return out
}

func setup(t *testing.T) (string, string, int) {
	t.Helper()
	srv, _, _ := testutil.NewServer(t)
	tok := register(t, srv.URL, "owner", "owner@example.com", "password123")
	return srv.URL, tok, newPlanner(t, srv.URL, tok)
}

// The pre-existing contract: asking twice for the public link returns the same
// token. P5 must not change this.
func TestCreateShareToken_UnlabelledIsIdempotent(t *testing.T) {
	base, tok, pid := setup(t)

	first, _ := mintToken(t, base, tok, pid, "")
	second, _ := mintToken(t, base, tok, pid, "")

	if first == "" {
		t.Fatal("no token returned")
	}
	if first != second {
		t.Errorf("unlabelled create should be idempotent: %q then %q", first, second)
	}
}

func TestCreateShareToken_LabelledIsDistinct(t *testing.T) {
	base, tok, pid := setup(t)

	public, _ := mintToken(t, base, tok, pid, "")
	display, _ := mintToken(t, base, tok, pid, "wall display")

	if display == "" {
		t.Fatal("no labelled token returned")
	}
	if display == public {
		t.Error("labelled token must not reuse the unlabelled public link")
	}
}

func TestCreateShareToken_SameLabelIsIdempotent(t *testing.T) {
	base, tok, pid := setup(t)

	first, _ := mintToken(t, base, tok, pid, "wall display")
	second, _ := mintToken(t, base, tok, pid, "wall display")

	if first != second {
		t.Errorf("same label should return same token: %q then %q", first, second)
	}
}

func TestCreateShareToken_DifferentLabelsAreDistinct(t *testing.T) {
	base, tok, pid := setup(t)

	lobby, _ := mintToken(t, base, tok, pid, "lobby screen")
	kitchen, _ := mintToken(t, base, tok, pid, "kitchen screen")

	if lobby == kitchen {
		t.Error("different labels must mint different tokens")
	}
}

func TestCreateShareToken_LabelTooLongRejected(t *testing.T) {
	base, tok, pid := setup(t)

	_, status := mintToken(t, base, tok, pid, strings.Repeat("x", 65))
	if status != http.StatusBadRequest {
		t.Errorf("expected 400 for an over-long label, got %d", status)
	}
}

func TestListShareTokens_ReportsLabels(t *testing.T) {
	base, tok, pid := setup(t)

	public, _ := mintToken(t, base, tok, pid, "")
	display, _ := mintToken(t, base, tok, pid, "wall display")

	var sawPublic, sawDisplay bool
	for _, e := range listTokens(t, base, tok, pid) {
		switch e.Token {
		case public:
			sawPublic = true
			if e.Label != nil {
				t.Errorf("public link should have a null label, got %q", *e.Label)
			}
		case display:
			sawDisplay = true
			if e.Label == nil || *e.Label != "wall display" {
				t.Errorf("display token label = %v, want \"wall display\"", e.Label)
			}
		}
	}
	if !sawPublic || !sawDisplay {
		t.Errorf("list missing tokens: public=%v display=%v", sawPublic, sawDisplay)
	}
}

// The reason P5 exists. Revoking the link you emailed a colleague must not
// blank the screen on the wall.
func TestRevoke_IsIndependentPerToken(t *testing.T) {
	base, tok, pid := setup(t)

	public, _ := mintToken(t, base, tok, pid, "")
	display, _ := mintToken(t, base, tok, pid, "wall display")

	resp, raw := do(t, "POST",
		fmt.Sprintf("%s/api/planners/%d/share-tokens/%s/revoke", base, pid, public), tok, map[string]any{})
	if resp.StatusCode != 200 {
		t.Fatalf("revoke: %d %s", resp.StatusCode, raw)
	}

	// The revoked public link must be dead.
	deadResp, _ := do(t, "GET", base+"/api/public/planners/"+public, "", nil)
	if deadResp.StatusCode == 200 {
		t.Error("revoked public link still resolves")
	}

	// The display token must still work.
	liveResp, liveRaw := do(t, "GET", base+"/api/public/planners/"+display, "", nil)
	if liveResp.StatusCode != 200 {
		t.Fatalf("display token died with the public link: %d %s", liveResp.StatusCode, liveRaw)
	}
}

// After revoking the public link, asking for it again mints a fresh one rather
// than resurrecting the revoked token.
func TestCreateShareToken_AfterRevokeMintsFresh(t *testing.T) {
	base, tok, pid := setup(t)

	first, _ := mintToken(t, base, tok, pid, "")
	resp, raw := do(t, "POST",
		fmt.Sprintf("%s/api/planners/%d/share-tokens/%s/revoke", base, pid, first), tok, map[string]any{})
	if resp.StatusCode != 200 {
		t.Fatalf("revoke: %d %s", resp.StatusCode, raw)
	}

	second, _ := mintToken(t, base, tok, pid, "")
	if second == first {
		t.Error("create returned the revoked token instead of minting a fresh one")
	}
	if second == "" {
		t.Error("no replacement token minted")
	}
}
