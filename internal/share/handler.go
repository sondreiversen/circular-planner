// Package share implements /api/planners/{plannerID}/shares/* routes.
package share

import (
	"encoding/json"
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
		SELECT u.id AS user_id, u.username, u.email, ps.permission
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
		Permission string `json:"permission"`
	}
	var result []share
	for rows.Next() {
		var s share
		if err := rows.Scan(&s.UserID, &s.Username, &s.Email, &s.Permission); err != nil {
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
