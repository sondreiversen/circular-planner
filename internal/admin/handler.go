// Package admin implements /api/admin/* routes for global admin management.
package admin

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"planner/internal/db"
	"planner/internal/middleware"
)

// Handler handles admin routes.
type Handler struct {
	db *db.DB
}

func NewHandler(database *db.DB) *Handler {
	return &Handler{db: database}
}

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

// guardLastGlobalAdmin returns an error if targetUserID is an admin and they
// are the only remaining global admin.
func (h *Handler) guardLastGlobalAdmin(r *http.Request, targetUserID int) error {
	var isAdmin bool
	err := h.db.QueryRowContext(r.Context(),
		h.db.Rebind("SELECT is_admin FROM users WHERE id = ?"), targetUserID,
	).Scan(&isAdmin)
	if errors.Is(err, sql.ErrNoRows) || !isAdmin {
		return nil
	}
	var count int
	if err := h.db.QueryRowContext(r.Context(),
		h.db.Rebind("SELECT COUNT(*) FROM users WHERE is_admin = 1"),
	).Scan(&count); err != nil {
		return errors.New("internal server error")
	}
	if count <= 1 {
		return errors.New("cannot remove or demote the last global admin")
	}
	return nil
}

// --- GET /api/admin/users ---

func (h *Handler) ListUsers(w http.ResponseWriter, r *http.Request) {
	rows, err := h.db.QueryContext(r.Context(),
		`SELECT id, username, email, auth_provider, is_admin, created_at FROM users ORDER BY id`,
	)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	defer rows.Close()

	type userRow struct {
		ID           int     `json:"id"`
		Username     string  `json:"username"`
		Email        string  `json:"email"`
		AuthProvider *string `json:"auth_provider"`
		IsAdmin      bool    `json:"is_admin"`
		CreatedAt    string  `json:"created_at"`
	}
	result := make([]userRow, 0)
	for rows.Next() {
		var u userRow
		var isAdminInt int
		if err := rows.Scan(&u.ID, &u.Username, &u.Email, &u.AuthProvider, &isAdminInt, &u.CreatedAt); err != nil {
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
		u.IsAdmin = isAdminInt == 1
		result = append(result, u)
	}
	writeJSON(w, http.StatusOK, result)
}

// --- PATCH /api/admin/users/{id} ---

func (h *Handler) UpdateUser(w http.ResponseWriter, r *http.Request) {
	caller := middleware.UserFrom(r)
	targetID, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid user ID")
		return
	}

	var body struct {
		IsAdmin *bool `json:"is_admin"`
	}
	if err := readJSON(r, &body); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	if body.IsAdmin == nil {
		jsonError(w, http.StatusBadRequest, "is_admin is required")
		return
	}

	if !*body.IsAdmin {
		if err := h.guardLastGlobalAdmin(r, targetID); err != nil {
			jsonError(w, http.StatusConflict, err.Error())
			return
		}
		if caller.ID == targetID {
			if err := h.guardLastGlobalAdmin(r, targetID); err != nil {
				jsonError(w, http.StatusConflict, err.Error())
				return
			}
		}
	}

	val := 0
	if *body.IsAdmin {
		val = 1
	}
	if _, err := h.db.ExecContext(r.Context(),
		h.db.Rebind("UPDATE users SET is_admin = ? WHERE id = ?"), val, targetID,
	); err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// --- DELETE /api/admin/users/{id} ---

func (h *Handler) DeleteUser(w http.ResponseWriter, r *http.Request) {
	caller := middleware.UserFrom(r)
	targetID, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid user ID")
		return
	}
	if caller.ID == targetID {
		jsonError(w, http.StatusBadRequest, "Cannot delete your own account")
		return
	}
	if err := h.guardLastGlobalAdmin(r, targetID); err != nil {
		jsonError(w, http.StatusConflict, err.Error())
		return
	}

	if _, err := h.db.ExecContext(r.Context(),
		h.db.Rebind("DELETE FROM users WHERE id = ?"), targetID,
	); err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// --- GET /api/admin/groups ---

func (h *Handler) ListGroups(w http.ResponseWriter, r *http.Request) {
	rows, err := h.db.QueryContext(r.Context(),
		`SELECT g.id, g.name, g.description,
			(SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count
		FROM groups g
		ORDER BY g.name`,
	)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	defer rows.Close()

	type groupRow struct {
		ID          int     `json:"id"`
		Name        string  `json:"name"`
		Description *string `json:"description"`
		MemberCount int     `json:"member_count"`
	}
	result := make([]groupRow, 0)
	for rows.Next() {
		var g groupRow
		if err := rows.Scan(&g.ID, &g.Name, &g.Description, &g.MemberCount); err != nil {
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
		result = append(result, g)
	}
	writeJSON(w, http.StatusOK, result)
}

// --- GET /api/admin/groups/{id}/members ---

func (h *Handler) ListGroupMembers(w http.ResponseWriter, r *http.Request) {
	groupID, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid group ID")
		return
	}

	rows, err := h.db.QueryContext(r.Context(),
		h.db.Rebind(`SELECT u.id, u.username, u.email, gm.role
		FROM group_members gm
		JOIN users u ON u.id = gm.user_id
		WHERE gm.group_id = ?
		ORDER BY u.username`),
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
		Role     string `json:"role"`
	}
	result := make([]member, 0)
	for rows.Next() {
		var m member
		if err := rows.Scan(&m.UserID, &m.Username, &m.Email, &m.Role); err != nil {
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
		result = append(result, m)
	}
	writeJSON(w, http.StatusOK, result)
}

// --- POST /api/admin/groups/{id}/members ---

func (h *Handler) AddGroupMember(w http.ResponseWriter, r *http.Request) {
	groupID, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid group ID")
		return
	}

	var body struct {
		UserID int    `json:"user_id"`
		Role   string `json:"role"`
	}
	body.Role = "member"
	if err := readJSON(r, &body); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	if body.UserID == 0 {
		jsonError(w, http.StatusBadRequest, "user_id is required")
		return
	}
	if body.Role != "admin" && body.Role != "member" {
		jsonError(w, http.StatusBadRequest, "role must be admin or member")
		return
	}

	var exists int
	if err := h.db.QueryRowContext(r.Context(),
		h.db.Rebind("SELECT COUNT(*) FROM users WHERE id = ?"), body.UserID,
	).Scan(&exists); err != nil || exists == 0 {
		jsonError(w, http.StatusNotFound, "User not found")
		return
	}

	var upsertSQL string
	if h.db.Dialect == db.SQLite {
		upsertSQL = "INSERT INTO group_members(group_id, user_id, role) VALUES(?,?,?) ON CONFLICT(group_id, user_id) DO UPDATE SET role=excluded.role"
	} else {
		upsertSQL = "INSERT INTO group_members(group_id, user_id, role) VALUES($1,$2,$3) ON CONFLICT (group_id, user_id) DO UPDATE SET role=$3"
	}
	if _, err := h.db.ExecContext(r.Context(), upsertSQL, groupID, body.UserID, body.Role); err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// --- PATCH /api/admin/groups/{id}/members/{userID} ---

func (h *Handler) UpdateGroupMember(w http.ResponseWriter, r *http.Request) {
	groupID, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
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

	if body.Role == "member" {
		if err := h.guardLastGroupAdmin(r, groupID, targetID); err != nil {
			jsonError(w, http.StatusConflict, err.Error())
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

// --- DELETE /api/admin/groups/{id}/members/{userID} ---

func (h *Handler) RemoveGroupMember(w http.ResponseWriter, r *http.Request) {
	groupID, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid group ID")
		return
	}
	targetID, err := strconv.Atoi(r.PathValue("userID"))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid user ID")
		return
	}

	if err := h.guardLastGroupAdmin(r, groupID, targetID); err != nil {
		jsonError(w, http.StatusConflict, err.Error())
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

// guardLastGroupAdmin prevents removing or demoting the last admin of a group.
func (h *Handler) guardLastGroupAdmin(r *http.Request, groupID, targetUserID int) error {
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
		return errors.New("internal server error")
	}
	if count <= 1 {
		return errors.New("cannot remove or demote the last admin")
	}
	return nil
}
