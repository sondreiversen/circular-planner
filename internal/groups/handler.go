// Package groups implements /api/groups/* routes.
package groups

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

// Handler handles group routes.
type Handler struct {
	db  *db.DB
	cfg *config.Config
}

func NewHandler(database *db.DB, cfg *config.Config) *Handler {
	return &Handler{db: database, cfg: cfg}
}

// Register mounts group routes on mux. All routes require authentication.
func (h *Handler) Register(mux *http.ServeMux, cfg *config.Config, database *db.DB) {
	auth := func(fn http.HandlerFunc) http.HandlerFunc {
		return middleware.RequireAuth(cfg, database, fn)
	}
	mux.HandleFunc("GET /api/groups", auth(h.List))
	mux.HandleFunc("POST /api/groups", auth(h.Create))
	mux.HandleFunc("GET /api/groups/{id}", auth(h.Get))
	mux.HandleFunc("PATCH /api/groups/{id}", auth(h.Update))
	mux.HandleFunc("DELETE /api/groups/{id}", auth(h.Delete))
	mux.HandleFunc("POST /api/groups/{id}/members", auth(h.AddMember))
	mux.HandleFunc("PATCH /api/groups/{id}/members/{userID}", auth(h.UpdateMember))
	mux.HandleFunc("DELETE /api/groups/{id}/members/{userID}", auth(h.RemoveMember))
}

// --- helpers ---

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func jsonError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func readJSON(r *http.Request, v any) error {
	return json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v)
}

func groupIDFromPath(r *http.Request) (int, bool) {
	id, err := strconv.Atoi(r.PathValue("id"))
	return id, err == nil
}

// requireGroupRole returns a non-nil error (with HTTP status) if the user
// does not have at least the required role in the group.
type groupErr struct {
	status int
	msg    string
}

func (e *groupErr) Error() string { return e.msg }

func (h *Handler) checkGroupRole(r *http.Request, groupID, userID int, required string) error {
	var role string
	err := h.db.QueryRowContext(r.Context(),
		h.db.Rebind("SELECT role FROM group_members WHERE group_id = ? AND user_id = ?"),
		groupID, userID,
	).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return &groupErr{403, "Access denied"}
	}
	if err != nil {
		return &groupErr{500, "Internal server error"}
	}
	if required == "admin" && role != "admin" {
		return &groupErr{403, "Admin access required"}
	}
	return nil
}

func (h *Handler) guardLastAdmin(r *http.Request, groupID, targetUserID int) error {
	var role string
	err := h.db.QueryRowContext(r.Context(),
		h.db.Rebind("SELECT role FROM group_members WHERE group_id = ? AND user_id = ?"),
		groupID, targetUserID,
	).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) || role != "admin" {
		return nil
	}
	var count int
	if err := h.db.QueryRowContext(r.Context(),
		h.db.Rebind("SELECT COUNT(*) FROM group_members WHERE group_id = ? AND role = 'admin'"),
		groupID,
	).Scan(&count); err != nil {
		return &groupErr{500, "Internal server error"}
	}
	if count <= 1 {
		return &groupErr{400, "Cannot remove or demote the last admin"}
	}
	return nil
}

func handleGroupErr(w http.ResponseWriter, err error) {
	var ge *groupErr
	if errors.As(err, &ge) {
		jsonError(w, ge.status, ge.msg)
		return
	}
	jsonError(w, http.StatusInternalServerError, "Internal server error")
}

// --- GET /api/groups ---

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserFrom(r).ID

	rows, err := h.db.QueryContext(r.Context(),
		h.db.Rebind(`SELECT g.id, g.name, g.description, gm.role,
			(SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count
		FROM groups g
		JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
		ORDER BY g.name`),
		userID,
	)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	defer rows.Close()

	type row struct {
		ID          int     `json:"id"`
		Name        string  `json:"name"`
		Description *string `json:"description"`
		Role        string  `json:"role"`
		MemberCount int     `json:"member_count"`
	}
	result := make([]row, 0)
	for rows.Next() {
		var gr row
		if err := rows.Scan(&gr.ID, &gr.Name, &gr.Description, &gr.Role, &gr.MemberCount); err != nil {
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
		result = append(result, gr)
	}
	writeJSON(w, http.StatusOK, result)
}

// --- POST /api/groups ---

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserFrom(r).ID
	var body struct {
		Name        string  `json:"name"`
		Description *string `json:"description"`
	}
	if err := readJSON(r, &body); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		jsonError(w, http.StatusBadRequest, "name is required")
		return
	}
	var desc *string
	if body.Description != nil {
		s := strings.TrimSpace(*body.Description)
		if s != "" {
			desc = &s
		}
	}

	tx, err := h.db.BeginTx(r.Context(), nil)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	defer func() { _ = tx.Rollback() }()

	var groupID int
	err = tx.QueryRowContext(r.Context(),
		h.db.Rebind("INSERT INTO groups(name, description, created_by) VALUES(?,?,?) RETURNING id"),
		name, desc, userID,
	).Scan(&groupID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	if _, err := tx.ExecContext(r.Context(),
		h.db.Rebind("INSERT INTO group_members(group_id, user_id, role) VALUES(?,?,'admin')"),
		groupID, userID,
	); err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	if err := tx.Commit(); err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":           groupID,
		"name":         name,
		"role":         "admin",
		"member_count": 1,
	})
}

// --- GET /api/groups/{id} ---

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserFrom(r).ID
	groupID, ok := groupIDFromPath(r)
	if !ok {
		jsonError(w, http.StatusBadRequest, "Invalid group ID")
		return
	}

	var group struct {
		ID          int     `json:"id"`
		Name        string  `json:"name"`
		Description *string `json:"description"`
		Role        string  `json:"role"`
	}
	err := h.db.QueryRowContext(r.Context(),
		h.db.Rebind(`SELECT g.id, g.name, g.description, gm.role
		FROM groups g
		JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
		WHERE g.id = ?`),
		userID, groupID,
	).Scan(&group.ID, &group.Name, &group.Description, &group.Role)
	if errors.Is(err, sql.ErrNoRows) {
		jsonError(w, http.StatusForbidden, "Access denied")
		return
	}
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	rows, err := h.db.QueryContext(r.Context(),
		h.db.Rebind(`SELECT u.id, u.username, u.email, COALESCE(u.full_name,'') AS full_name, gm.role
		FROM group_members gm
		JOIN users u ON u.id = gm.user_id
		WHERE gm.group_id = ?
		ORDER BY COALESCE(NULLIF(u.full_name,''), u.username)`),
		groupID,
	)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	defer rows.Close()

	type member struct {
		UserID   int    `json:"user_id"`
		Username string `json:"username"`
		Email    string `json:"email"`
		FullName string `json:"fullName,omitempty"`
		Role     string `json:"role"`
	}
	members := make([]member, 0)
	for rows.Next() {
		var m member
		if err := rows.Scan(&m.UserID, &m.Username, &m.Email, &m.FullName, &m.Role); err != nil {
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
		members = append(members, m)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"id":          group.ID,
		"name":        group.Name,
		"description": group.Description,
		"role":        group.Role,
		"members":     members,
	})
}

// --- PATCH /api/groups/{id} ---

func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserFrom(r).ID
	groupID, ok := groupIDFromPath(r)
	if !ok {
		jsonError(w, http.StatusBadRequest, "Invalid group ID")
		return
	}

	if err := h.checkGroupRole(r, groupID, userID, "admin"); err != nil {
		handleGroupErr(w, err)
		return
	}

	var body struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
	}
	if err := readJSON(r, &body); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	if body.Name != nil && strings.TrimSpace(*body.Name) == "" {
		jsonError(w, http.StatusBadRequest, "name cannot be empty")
		return
	}

	var nameVal *string
	if body.Name != nil {
		s := strings.TrimSpace(*body.Name)
		nameVal = &s
	}
	var descVal *string
	if body.Description != nil {
		s := strings.TrimSpace(*body.Description)
		if s != "" {
			descVal = &s
		}
	}

	// COALESCE for name; explicit NULL or keep existing for description
	if nameVal != nil && body.Description != nil {
		_, err := h.db.ExecContext(r.Context(),
			h.db.Rebind("UPDATE groups SET name = ?, description = ? WHERE id = ?"),
			*nameVal, descVal, groupID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
	} else if nameVal != nil {
		_, err := h.db.ExecContext(r.Context(),
			h.db.Rebind("UPDATE groups SET name = ? WHERE id = ?"),
			*nameVal, groupID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
	} else if body.Description != nil {
		_, err := h.db.ExecContext(r.Context(),
			h.db.Rebind("UPDATE groups SET description = ? WHERE id = ?"),
			descVal, groupID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// --- DELETE /api/groups/{id} ---

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserFrom(r).ID
	groupID, ok := groupIDFromPath(r)
	if !ok {
		jsonError(w, http.StatusBadRequest, "Invalid group ID")
		return
	}

	if err := h.checkGroupRole(r, groupID, userID, "admin"); err != nil {
		handleGroupErr(w, err)
		return
	}

	if _, err := h.db.ExecContext(r.Context(),
		h.db.Rebind("DELETE FROM groups WHERE id = ?"), groupID,
	); err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// --- POST /api/groups/{id}/members ---

func (h *Handler) AddMember(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserFrom(r).ID
	groupID, ok := groupIDFromPath(r)
	if !ok {
		jsonError(w, http.StatusBadRequest, "Invalid group ID")
		return
	}

	var body struct {
		UserIDs []int  `json:"user_ids"`
		Role    string `json:"role"`
	}
	body.Role = "member"
	if err := readJSON(r, &body); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	if len(body.UserIDs) == 0 {
		jsonError(w, http.StatusBadRequest, "user_ids is required")
		return
	}
	if len(body.UserIDs) > 100 {
		jsonError(w, http.StatusBadRequest, "too many users")
		return
	}
	if body.Role != "admin" && body.Role != "member" {
		jsonError(w, http.StatusBadRequest, "role must be admin or member")
		return
	}

	if err := h.checkGroupRole(r, groupID, userID, "admin"); err != nil {
		handleGroupErr(w, err)
		return
	}

	// Deduplicate user IDs
	seen := make(map[int]struct{}, len(body.UserIDs))
	unique := body.UserIDs[:0]
	for _, id := range body.UserIDs {
		if _, ok := seen[id]; !ok {
			seen[id] = struct{}{}
			unique = append(unique, id)
		}
	}
	body.UserIDs = unique

	// Verify all target users exist in one query
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(body.UserIDs)), ",")
	args := make([]any, len(body.UserIDs))
	for i, id := range body.UserIDs {
		args[i] = id
	}
	var count int
	if err := h.db.QueryRowContext(r.Context(),
		h.db.Rebind("SELECT COUNT(*) FROM users WHERE id IN ("+placeholders+")"),
		args...,
	).Scan(&count); err != nil || count != len(body.UserIDs) {
		jsonError(w, http.StatusNotFound, "one or more users not found")
		return
	}

	// Wrap upserts in a single transaction
	tx, err := h.db.BeginTx(r.Context(), nil)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	defer func() { _ = tx.Rollback() }()

	var upsertSQL string
	if h.db.Dialect == db.SQLite {
		upsertSQL = "INSERT INTO group_members(group_id, user_id, role) VALUES(?,?,?) ON CONFLICT(group_id, user_id) DO UPDATE SET role=excluded.role"
	} else {
		upsertSQL = "INSERT INTO group_members(group_id, user_id, role) VALUES($1,$2,$3) ON CONFLICT (group_id, user_id) DO UPDATE SET role=$3"
	}
	for _, uid := range body.UserIDs {
		if _, err := tx.ExecContext(r.Context(), upsertSQL, groupID, uid, body.Role); err != nil {
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
	}

	if err := tx.Commit(); err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// --- PATCH /api/groups/{id}/members/{userID} ---

func (h *Handler) UpdateMember(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserFrom(r).ID
	groupID, ok := groupIDFromPath(r)
	if !ok {
		jsonError(w, http.StatusBadRequest, "Invalid group ID")
		return
	}
	targetID, err := strconv.Atoi(r.PathValue("userID"))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid user ID")
		return
	}

	var body struct {
		Role string `json:"role"`
	}
	if err := readJSON(r, &body); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	if body.Role != "admin" && body.Role != "member" {
		jsonError(w, http.StatusBadRequest, "role must be admin or member")
		return
	}

	if err := h.checkGroupRole(r, groupID, callerID, "admin"); err != nil {
		handleGroupErr(w, err)
		return
	}
	if body.Role == "member" {
		if err := h.guardLastAdmin(r, groupID, targetID); err != nil {
			handleGroupErr(w, err)
			return
		}
	}

	if _, err := h.db.ExecContext(r.Context(),
		h.db.Rebind("UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?"),
		body.Role, groupID, targetID,
	); err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// --- DELETE /api/groups/{id}/members/{userID} ---

func (h *Handler) RemoveMember(w http.ResponseWriter, r *http.Request) {
	callerID := middleware.UserFrom(r).ID
	groupID, ok := groupIDFromPath(r)
	if !ok {
		jsonError(w, http.StatusBadRequest, "Invalid group ID")
		return
	}
	targetID, err := strconv.Atoi(r.PathValue("userID"))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid user ID")
		return
	}

	if callerID != targetID {
		if err := h.checkGroupRole(r, groupID, callerID, "admin"); err != nil {
			handleGroupErr(w, err)
			return
		}
	} else {
		// Self-leave: verify caller is a member
		var role string
		if err := h.db.QueryRowContext(r.Context(),
			h.db.Rebind("SELECT role FROM group_members WHERE group_id = ? AND user_id = ?"),
			groupID, callerID,
		).Scan(&role); errors.Is(err, sql.ErrNoRows) {
			jsonError(w, http.StatusForbidden, "Not a member")
			return
		}
	}

	if err := h.guardLastAdmin(r, groupID, targetID); err != nil {
		handleGroupErr(w, err)
		return
	}

	if _, err := h.db.ExecContext(r.Context(),
		h.db.Rebind("DELETE FROM group_members WHERE group_id = ? AND user_id = ?"),
		groupID, targetID,
	); err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}
