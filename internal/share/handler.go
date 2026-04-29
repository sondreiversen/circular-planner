// Package share implements /api/planners/{plannerID}/shares/* routes.
package share

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"planner/internal/config"
	"planner/internal/db"
	"planner/internal/middleware"
)

// Handler handles share routes.
type Handler struct {
	db  *db.DB
	cfg *config.Config
}

func NewHandler(database *db.DB, cfg *config.Config) *Handler {
	return &Handler{db: database, cfg: cfg}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func jsonError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func handleAccessErr(w http.ResponseWriter, err error) {
	if ae, ok := err.(*middleware.AccessError); ok {
		jsonError(w, ae.Status, ae.Message)
		return
	}
	jsonError(w, http.StatusInternalServerError, "Internal server error")
}

func plannerIDFromPath(r *http.Request) (int, bool) {
	id, err := strconv.Atoi(r.PathValue("plannerID"))
	return id, err == nil
}

// GET /api/planners/{plannerID}/shares
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	plannerID, ok := plannerIDFromPath(r)
	if !ok {
		jsonError(w, http.StatusBadRequest, "Invalid planner ID")
		return
	}
	userID := middleware.UserFrom(r).ID

	if _, err := middleware.CanAccess(r.Context(), h.db, plannerID, userID, "owner"); err != nil {
		handleAccessErr(w, err)
		return
	}

	rows, err := h.db.QueryContext(r.Context(), h.db.Rebind(`
		SELECT u.id AS user_id, u.username, u.email, COALESCE(u.full_name,'') AS full_name, ps.permission
		FROM planner_shares ps
		JOIN users u ON u.id = ps.user_id
		WHERE ps.planner_id = ?
	`), plannerID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	defer rows.Close()

	type share struct {
		UserID     int    `json:"user_id"`
		Username   string `json:"username"`
		Email      string `json:"email"`
		FullName   string `json:"fullName,omitempty"`
		Permission string `json:"permission"`
	}
	var result []share
	for rows.Next() {
		var s share
		if err := rows.Scan(&s.UserID, &s.Username, &s.Email, &s.FullName, &s.Permission); err != nil {
			continue
		}
		result = append(result, s)
	}
	if result == nil {
		result = []share{}
	}
	writeJSON(w, http.StatusOK, result)
}

// POST /api/planners/{plannerID}/shares
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	plannerID, ok := plannerIDFromPath(r)
	if !ok {
		jsonError(w, http.StatusBadRequest, "Invalid planner ID")
		return
	}
	userID := middleware.UserFrom(r).ID

	if _, err := middleware.CanAccess(r.Context(), h.db, plannerID, userID, "owner"); err != nil {
		handleAccessErr(w, err)
		return
	}

	var body struct {
		Email      string `json:"email"`
		Permission string `json:"permission"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	if body.Email == "" {
		jsonError(w, http.StatusBadRequest, "email is required")
		return
	}
	perm := body.Permission
	if perm == "" {
		perm = "view"
	}
	if perm != "view" && perm != "edit" {
		jsonError(w, http.StatusBadRequest, "permission must be view or edit")
		return
	}

	var targetID int
	err := h.db.QueryRowContext(r.Context(),
		h.db.Rebind("SELECT id FROM users WHERE email = ?"),
		strings.ToLower(body.Email),
	).Scan(&targetID)
	if err != nil {
		jsonError(w, http.StatusNotFound, "No user with that email address")
		return
	}
	if targetID == userID {
		jsonError(w, http.StatusBadRequest, "Cannot share with yourself")
		return
	}

	_, err = h.db.ExecContext(r.Context(), h.db.Rebind(`
		INSERT INTO planner_shares(planner_id, user_id, permission)
		VALUES (?, ?, ?)
		ON CONFLICT(planner_id, user_id) DO UPDATE SET permission = excluded.permission
	`), plannerID, targetID, perm)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// DELETE /api/planners/{plannerID}/shares/{userID}
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	plannerID, ok := plannerIDFromPath(r)
	if !ok {
		jsonError(w, http.StatusBadRequest, "Invalid planner ID")
		return
	}
	userID := middleware.UserFrom(r).ID

	if _, err := middleware.CanAccess(r.Context(), h.db, plannerID, userID, "owner"); err != nil {
		handleAccessErr(w, err)
		return
	}

	targetUserID, err := strconv.Atoi(r.PathValue("userID"))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid user ID")
		return
	}

	_, err = h.db.ExecContext(r.Context(),
		h.db.Rebind("DELETE FROM planner_shares WHERE planner_id = ? AND user_id = ?"),
		plannerID, targetUserID,
	)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// GET /api/planners/{plannerID}/shares/group-shares
func (h *Handler) ListGroupShares(w http.ResponseWriter, r *http.Request) {
	plannerID, ok := plannerIDFromPath(r)
	if !ok {
		jsonError(w, http.StatusBadRequest, "Invalid planner ID")
		return
	}
	userID := middleware.UserFrom(r).ID

	if _, err := middleware.CanAccess(r.Context(), h.db, plannerID, userID, "owner"); err != nil {
		handleAccessErr(w, err)
		return
	}

	rows, err := h.db.QueryContext(r.Context(), h.db.Rebind(`
		SELECT g.id AS group_id, g.name, pgs.default_permission,
		       (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count
		FROM planner_group_shares pgs
		JOIN groups g ON g.id = pgs.group_id
		WHERE pgs.planner_id = ?
		ORDER BY g.name
	`), plannerID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	defer rows.Close()

	type groupShare struct {
		GroupID           int    `json:"group_id"`
		Name              string `json:"name"`
		MemberCount       int    `json:"member_count"`
		DefaultPermission string `json:"default_permission"`
	}
	var groups []groupShare
	for rows.Next() {
		var gs groupShare
		if err := rows.Scan(&gs.GroupID, &gs.Name, &gs.DefaultPermission, &gs.MemberCount); err != nil {
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
		groups = append(groups, gs)
	}
	rows.Close()

	// Fetch all overrides for this planner in a single query
	type override struct {
		GroupID    int    `json:"group_id"`
		UserID     int    `json:"user_id"`
		Username   string `json:"username"`
		Permission string `json:"permission"`
	}
	orows, err := h.db.QueryContext(r.Context(), h.db.Rebind(`
		SELECT pgmo.group_id, pgmo.user_id, u.username, pgmo.permission
		FROM planner_group_member_overrides pgmo
		JOIN users u ON u.id = pgmo.user_id
		WHERE pgmo.planner_id = ?
	`), plannerID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	defer orows.Close()

	overridesByGroup := make(map[int][]override)
	for orows.Next() {
		var o override
		if err := orows.Scan(&o.GroupID, &o.UserID, &o.Username, &o.Permission); err != nil {
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
		overridesByGroup[o.GroupID] = append(overridesByGroup[o.GroupID], o)
	}

	type result struct {
		GroupID           int        `json:"group_id"`
		Name              string     `json:"name"`
		MemberCount       int        `json:"member_count"`
		DefaultPermission string     `json:"default_permission"`
		Overrides         []override `json:"overrides"`
	}
	out := make([]result, 0, len(groups))
	for _, gs := range groups {
		ov := overridesByGroup[gs.GroupID]
		if ov == nil {
			ov = []override{}
		}
		out = append(out, result{
			GroupID:           gs.GroupID,
			Name:              gs.Name,
			MemberCount:       gs.MemberCount,
			DefaultPermission: gs.DefaultPermission,
			Overrides:         ov,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// POST /api/planners/{plannerID}/shares/group-shares
func (h *Handler) CreateGroupShare(w http.ResponseWriter, r *http.Request) {
	plannerID, ok := plannerIDFromPath(r)
	if !ok {
		jsonError(w, http.StatusBadRequest, "Invalid planner ID")
		return
	}
	userID := middleware.UserFrom(r).ID

	if _, err := middleware.CanAccess(r.Context(), h.db, plannerID, userID, "owner"); err != nil {
		handleAccessErr(w, err)
		return
	}

	var body struct {
		GroupID           int    `json:"group_id"`
		DefaultPermission string `json:"default_permission"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	if body.GroupID == 0 {
		jsonError(w, http.StatusBadRequest, "group_id is required")
		return
	}
	perm := body.DefaultPermission
	if perm == "" {
		perm = "view"
	}
	if perm != "view" && perm != "edit" {
		jsonError(w, http.StatusBadRequest, "default_permission must be view or edit")
		return
	}

	// Verify the group exists
	var exists int
	err := h.db.QueryRowContext(r.Context(),
		h.db.Rebind("SELECT COUNT(*) FROM groups WHERE id = ?"), body.GroupID,
	).Scan(&exists)
	if err != nil || exists == 0 {
		jsonError(w, http.StatusNotFound, "Group not found")
		return
	}

	_, err = h.db.ExecContext(r.Context(), h.db.Rebind(`
		INSERT INTO planner_group_shares(planner_id, group_id, default_permission)
		VALUES (?, ?, ?)
		ON CONFLICT(planner_id, group_id) DO UPDATE SET default_permission = excluded.default_permission
	`), plannerID, body.GroupID, perm)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// DELETE /api/planners/{plannerID}/shares/group-shares/{groupID}
func (h *Handler) DeleteGroupShare(w http.ResponseWriter, r *http.Request) {
	plannerID, ok := plannerIDFromPath(r)
	if !ok {
		jsonError(w, http.StatusBadRequest, "Invalid planner ID")
		return
	}
	userID := middleware.UserFrom(r).ID

	if _, err := middleware.CanAccess(r.Context(), h.db, plannerID, userID, "owner"); err != nil {
		handleAccessErr(w, err)
		return
	}

	groupID, err := strconv.Atoi(r.PathValue("groupID"))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid group ID")
		return
	}

	_, err = h.db.ExecContext(r.Context(),
		h.db.Rebind("DELETE FROM planner_group_shares WHERE planner_id = ? AND group_id = ?"),
		plannerID, groupID,
	)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// PUT /api/planners/{plannerID}/shares/group-shares/{groupID}/overrides/{userID}
func (h *Handler) UpsertGroupMemberOverride(w http.ResponseWriter, r *http.Request) {
	plannerID, ok := plannerIDFromPath(r)
	if !ok {
		jsonError(w, http.StatusBadRequest, "Invalid planner ID")
		return
	}
	userID := middleware.UserFrom(r).ID

	if _, err := middleware.CanAccess(r.Context(), h.db, plannerID, userID, "owner"); err != nil {
		handleAccessErr(w, err)
		return
	}

	groupID, err := strconv.Atoi(r.PathValue("groupID"))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid group ID")
		return
	}
	targetUserID, err := strconv.Atoi(r.PathValue("userID"))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid user ID")
		return
	}

	var body struct {
		Permission string `json:"permission"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	if body.Permission != "view" && body.Permission != "edit" {
		jsonError(w, http.StatusBadRequest, "permission must be view or edit")
		return
	}

	// Verify group share exists
	var dummy int
	err = h.db.QueryRowContext(r.Context(),
		h.db.Rebind("SELECT 1 FROM planner_group_shares WHERE planner_id = ? AND group_id = ?"),
		plannerID, groupID,
	).Scan(&dummy)
	if errors.Is(err, sql.ErrNoRows) {
		jsonError(w, http.StatusNotFound, "Group share not found")
		return
	}
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	_, err = h.db.ExecContext(r.Context(), h.db.Rebind(`
		INSERT INTO planner_group_member_overrides(planner_id, group_id, user_id, permission)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(planner_id, group_id, user_id) DO UPDATE SET permission = excluded.permission
	`), plannerID, groupID, targetUserID, body.Permission)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// DELETE /api/planners/{plannerID}/shares/group-shares/{groupID}/overrides/{userID}
func (h *Handler) DeleteGroupMemberOverride(w http.ResponseWriter, r *http.Request) {
	plannerID, ok := plannerIDFromPath(r)
	if !ok {
		jsonError(w, http.StatusBadRequest, "Invalid planner ID")
		return
	}
	userID := middleware.UserFrom(r).ID

	if _, err := middleware.CanAccess(r.Context(), h.db, plannerID, userID, "owner"); err != nil {
		handleAccessErr(w, err)
		return
	}

	groupID, err := strconv.Atoi(r.PathValue("groupID"))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid group ID")
		return
	}
	targetUserID, err := strconv.Atoi(r.PathValue("userID"))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid user ID")
		return
	}

	_, err = h.db.ExecContext(r.Context(),
		h.db.Rebind("DELETE FROM planner_group_member_overrides WHERE planner_id = ? AND group_id = ? AND user_id = ?"),
		plannerID, groupID, targetUserID,
	)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

