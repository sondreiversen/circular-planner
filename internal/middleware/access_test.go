package middleware_test

import (
	"context"
	"path/filepath"
	"testing"

	"planner/internal/db"
	"planner/internal/middleware"
)

// newTestDB opens a fresh, migrated SQLite database in a temp dir for direct
// row insertion — CanAccess is a pure DB-backed function with no HTTP layer,
// so we drive it straight against the DB rather than through testutil.NewServer.
func newTestDB(t *testing.T) *db.DB {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "test.db")
	database, err := db.Open("sqlite:" + dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		database.Close()
		t.Fatalf("db.Migrate: %v", err)
	}
	t.Cleanup(func() { database.Close() })
	return database
}

func insertUser(t *testing.T, database *db.DB, username string) int {
	t.Helper()
	var id int
	err := database.QueryRowContext(context.Background(), database.Rebind(
		"INSERT INTO users(username, email, password_hash) VALUES (?, ?, ?) RETURNING id"),
		username, username+"@example.com", "x",
	).Scan(&id)
	if err != nil {
		t.Fatalf("insertUser(%s): %v", username, err)
	}
	return id
}

func insertPlanner(t *testing.T, database *db.DB, ownerID int, isPublic bool) int {
	t.Helper()
	pub := 0
	if isPublic {
		pub = 1
	}
	var id int
	err := database.QueryRowContext(context.Background(), database.Rebind(
		`INSERT INTO planners(owner_id, title, start_date, end_date, is_public)
		 VALUES (?, ?, ?, ?, ?) RETURNING id`),
		ownerID, "Test Planner", "2026-01-01", "2026-12-31", pub,
	).Scan(&id)
	if err != nil {
		t.Fatalf("insertPlanner: %v", err)
	}
	return id
}

func insertShare(t *testing.T, database *db.DB, plannerID, userID int, permission string) {
	t.Helper()
	_, err := database.ExecContext(context.Background(), database.Rebind(
		"INSERT INTO planner_shares(planner_id, user_id, permission) VALUES (?, ?, ?)"),
		plannerID, userID, permission,
	)
	if err != nil {
		t.Fatalf("insertShare: %v", err)
	}
}

func insertGroup(t *testing.T, database *db.DB, createdBy int) int {
	t.Helper()
	var id int
	err := database.QueryRowContext(context.Background(), database.Rebind(
		"INSERT INTO groups(name, created_by) VALUES (?, ?) RETURNING id"),
		"Test Group", createdBy,
	).Scan(&id)
	if err != nil {
		t.Fatalf("insertGroup: %v", err)
	}
	return id
}

func addGroupMember(t *testing.T, database *db.DB, groupID, userID int, role string) {
	t.Helper()
	_, err := database.ExecContext(context.Background(), database.Rebind(
		"INSERT INTO group_members(group_id, user_id, role) VALUES (?, ?, ?)"),
		groupID, userID, role,
	)
	if err != nil {
		t.Fatalf("addGroupMember: %v", err)
	}
}

func addGroupShare(t *testing.T, database *db.DB, plannerID, groupID int, defaultPermission string) {
	t.Helper()
	_, err := database.ExecContext(context.Background(), database.Rebind(
		"INSERT INTO planner_group_shares(planner_id, group_id, default_permission) VALUES (?, ?, ?)"),
		plannerID, groupID, defaultPermission,
	)
	if err != nil {
		t.Fatalf("addGroupShare: %v", err)
	}
}

func addGroupOverride(t *testing.T, database *db.DB, plannerID, groupID, userID int, permission string) {
	t.Helper()
	_, err := database.ExecContext(context.Background(), database.Rebind(
		"INSERT INTO planner_group_member_overrides(planner_id, group_id, user_id, permission) VALUES (?, ?, ?, ?)"),
		plannerID, groupID, userID, permission,
	)
	if err != nil {
		t.Fatalf("addGroupOverride: %v", err)
	}
}

func wantAccessError(t *testing.T, err error, status int) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected AccessError with status %d, got nil error", status)
	}
	ae, ok := err.(*middleware.AccessError)
	if !ok {
		t.Fatalf("expected *middleware.AccessError, got %T: %v", err, err)
	}
	if ae.Status != status {
		t.Errorf("status: got %d, want %d (message: %s)", ae.Status, status, ae.Message)
	}
}

// --- Owner access ---

func TestCanAccess_Owner(t *testing.T) {
	database := newTestDB(t)
	owner := insertUser(t, database, "owner")
	plannerID := insertPlanner(t, database, owner, false)

	for _, require := range []string{"view", "edit", "owner"} {
		level, err := middleware.CanAccess(context.Background(), database, plannerID, owner, require)
		if err != nil {
			t.Errorf("owner require=%s: unexpected error %v", require, err)
		}
		if level != "owner" {
			t.Errorf("owner require=%s: level got %q, want %q", require, level, "owner")
		}
	}
}

// --- Direct per-user share: view permission ---

func TestCanAccess_DirectShareView(t *testing.T) {
	database := newTestDB(t)
	owner := insertUser(t, database, "owner2")
	viewer := insertUser(t, database, "viewer")
	plannerID := insertPlanner(t, database, owner, false)
	insertShare(t, database, plannerID, viewer, "view")

	level, err := middleware.CanAccess(context.Background(), database, plannerID, viewer, "view")
	if err != nil {
		t.Fatalf("view require=view: unexpected error %v", err)
	}
	if level != "view" {
		t.Errorf("view require=view: level got %q, want %q", level, "view")
	}

	_, err = middleware.CanAccess(context.Background(), database, plannerID, viewer, "edit")
	wantAccessError(t, err, 403)

	// require="owner" is rejected before the share table is even consulted.
	_, err = middleware.CanAccess(context.Background(), database, plannerID, viewer, "owner")
	wantAccessError(t, err, 403)
}

// --- Direct per-user share: edit permission ---

func TestCanAccess_DirectShareEdit(t *testing.T) {
	database := newTestDB(t)
	owner := insertUser(t, database, "owner3")
	editor := insertUser(t, database, "editor")
	plannerID := insertPlanner(t, database, owner, false)
	insertShare(t, database, plannerID, editor, "edit")

	// NOTE: CanAccess returns the user's ACTUAL resolved permission, not the
	// requested level — an edit-share satisfying require="view" still
	// resolves to "edit", not "view".
	level, err := middleware.CanAccess(context.Background(), database, plannerID, editor, "view")
	if err != nil {
		t.Fatalf("edit require=view: unexpected error %v", err)
	}
	if level != "edit" {
		t.Errorf("edit require=view: level got %q, want %q", level, "edit")
	}

	level, err = middleware.CanAccess(context.Background(), database, plannerID, editor, "edit")
	if err != nil {
		t.Fatalf("edit require=edit: unexpected error %v", err)
	}
	if level != "edit" {
		t.Errorf("edit require=edit: level got %q, want %q", level, "edit")
	}

	_, err = middleware.CanAccess(context.Background(), database, plannerID, editor, "owner")
	wantAccessError(t, err, 403)
}

// --- Public planner bypass ---

func TestCanAccess_PublicPlanner(t *testing.T) {
	database := newTestDB(t)
	owner := insertUser(t, database, "owner4")
	stranger := insertUser(t, database, "stranger")
	plannerID := insertPlanner(t, database, owner, true)

	// Any authenticated user (no share, no group) gets "view" on a public planner.
	level, err := middleware.CanAccess(context.Background(), database, plannerID, stranger, "view")
	if err != nil {
		t.Fatalf("public require=view: unexpected error %v", err)
	}
	if level != "view" {
		t.Errorf("public require=view: level got %q, want %q", level, "view")
	}

	// The public bypass only ever grants "view" — edit is still denied.
	_, err = middleware.CanAccess(context.Background(), database, plannerID, stranger, "edit")
	wantAccessError(t, err, 403)

	// require="owner" is rejected before the public flag is even checked.
	_, err = middleware.CanAccess(context.Background(), database, plannerID, stranger, "owner")
	wantAccessError(t, err, 403)
}

func TestCanAccess_PrivatePlannerDeniedForStranger(t *testing.T) {
	database := newTestDB(t)
	owner := insertUser(t, database, "owner5")
	stranger := insertUser(t, database, "stranger2")
	plannerID := insertPlanner(t, database, owner, false)

	_, err := middleware.CanAccess(context.Background(), database, plannerID, stranger, "view")
	wantAccessError(t, err, 403)
}

// --- Group-based access ---

func TestCanAccess_GroupDefaultPermission(t *testing.T) {
	database := newTestDB(t)
	owner := insertUser(t, database, "owner6")
	member := insertUser(t, database, "member1")
	plannerID := insertPlanner(t, database, owner, false)
	groupID := insertGroup(t, database, owner)
	addGroupMember(t, database, groupID, member, "member")
	addGroupShare(t, database, plannerID, groupID, "view")

	level, err := middleware.CanAccess(context.Background(), database, plannerID, member, "view")
	if err != nil {
		t.Fatalf("group view: unexpected error %v", err)
	}
	if level != "view" {
		t.Errorf("group view: level got %q, want %q", level, "view")
	}

	_, err = middleware.CanAccess(context.Background(), database, plannerID, member, "edit")
	wantAccessError(t, err, 403)
}

func TestCanAccess_GroupOverrideBeatsDefault_Upgrade(t *testing.T) {
	database := newTestDB(t)
	owner := insertUser(t, database, "owner7")
	member := insertUser(t, database, "member2")
	plannerID := insertPlanner(t, database, owner, false)
	groupID := insertGroup(t, database, owner)
	addGroupMember(t, database, groupID, member, "member")
	addGroupShare(t, database, plannerID, groupID, "view")
	addGroupOverride(t, database, plannerID, groupID, member, "edit")

	level, err := middleware.CanAccess(context.Background(), database, plannerID, member, "edit")
	if err != nil {
		t.Fatalf("override upgrade to edit: unexpected error %v", err)
	}
	if level != "edit" {
		t.Errorf("override upgrade: level got %q, want %q", level, "edit")
	}
}

func TestCanAccess_GroupOverrideBeatsDefault_Downgrade(t *testing.T) {
	database := newTestDB(t)
	owner := insertUser(t, database, "owner8")
	member := insertUser(t, database, "member3")
	plannerID := insertPlanner(t, database, owner, false)
	groupID := insertGroup(t, database, owner)
	addGroupMember(t, database, groupID, member, "member")
	addGroupShare(t, database, plannerID, groupID, "edit")
	addGroupOverride(t, database, plannerID, groupID, member, "view")

	// Override downgrades the member below the group's default "edit".
	level, err := middleware.CanAccess(context.Background(), database, plannerID, member, "view")
	if err != nil {
		t.Fatalf("override downgrade require=view: unexpected error %v", err)
	}
	if level != "view" {
		t.Errorf("override downgrade: level got %q, want %q", level, "view")
	}
	_, err = middleware.CanAccess(context.Background(), database, plannerID, member, "edit")
	wantAccessError(t, err, 403)
}

func TestCanAccess_BestOfMultipleGroupGrants(t *testing.T) {
	database := newTestDB(t)
	owner := insertUser(t, database, "owner9")
	member := insertUser(t, database, "member4")
	plannerID := insertPlanner(t, database, owner, false)

	groupA := insertGroup(t, database, owner)
	addGroupMember(t, database, groupA, member, "member")
	addGroupShare(t, database, plannerID, groupA, "view")

	groupB := insertGroup(t, database, owner)
	addGroupMember(t, database, groupB, member, "member")
	addGroupShare(t, database, plannerID, groupB, "edit")

	// Member is in two groups shared to the same planner: one view, one edit.
	// CanAccess takes the best (edit) across all group grants.
	level, err := middleware.CanAccess(context.Background(), database, plannerID, member, "edit")
	if err != nil {
		t.Fatalf("best-of-multiple: unexpected error %v", err)
	}
	if level != "edit" {
		t.Errorf("best-of-multiple: level got %q, want %q", level, "edit")
	}
}

// TestCanAccess_DirectShareShortCircuitsGroupGrants documents a real behavior
// (not a fix): when a user has BOTH a direct per-user share row AND separate
// group-based access to the same planner, CanAccess resolves the direct share
// first and returns immediately — it never looks at group grants at all, even
// when the group grant would have been more permissive. This means a
// direct "view" share can effectively cap a user below what their group
// membership would otherwise grant.
func TestCanAccess_DirectShareShortCircuitsGroupGrants(t *testing.T) {
	database := newTestDB(t)
	owner := insertUser(t, database, "owner10")
	user := insertUser(t, database, "dualaccess")
	plannerID := insertPlanner(t, database, owner, false)

	// Direct share: view only.
	insertShare(t, database, plannerID, user, "view")

	// Group share: edit — would satisfy require="edit" on its own.
	groupID := insertGroup(t, database, owner)
	addGroupMember(t, database, groupID, user, "member")
	addGroupShare(t, database, plannerID, groupID, "edit")

	// Current behavior: the direct share ("view") is found first and short-
	// circuits the function, so the edit-granting group membership is never
	// consulted. require="edit" is therefore denied despite the group grant.
	_, err := middleware.CanAccess(context.Background(), database, plannerID, user, "edit")
	wantAccessError(t, err, 403)
}

// --- Nonexistent planner ---

func TestCanAccess_NonexistentPlanner(t *testing.T) {
	database := newTestDB(t)
	owner := insertUser(t, database, "owner11")
	_ = owner

	_, err := middleware.CanAccess(context.Background(), database, 999999, owner, "view")
	wantAccessError(t, err, 404)
}

// --- Invalid permission value in DB (defensive branch) ---

func TestCanAccess_InvalidStoredPermission(t *testing.T) {
	database := newTestDB(t)
	owner := insertUser(t, database, "owner12")
	user := insertUser(t, database, "baddata")
	plannerID := insertPlanner(t, database, owner, false)

	// Bypass the application-level CHECK (planner_shares has none) to store an
	// invalid permission value directly, exercising CanAccess's defensive
	// 500 branch.
	_, err := database.ExecContext(context.Background(), database.Rebind(
		"INSERT INTO planner_shares(planner_id, user_id, permission) VALUES (?, ?, ?)"),
		plannerID, user, "bogus",
	)
	if err != nil {
		t.Fatalf("insert bad permission: %v", err)
	}

	_, err = middleware.CanAccess(context.Background(), database, plannerID, user, "view")
	wantAccessError(t, err, 500)
}
