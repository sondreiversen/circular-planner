// Package views implements /api/planners/{plannerID}/views/* routes.
package views

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"planner/internal/config"
	"planner/internal/db"
	"planner/internal/middleware"
)

// Handler handles saved-view routes.
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

type createdBy struct {
	ID       int    `json:"id"`
	Username string `json:"username"`
	FullName string `json:"fullName,omitempty"`
}

type savedView struct {
	ID        int       `json:"id"`
	Name      string    `json:"name"`
	State     string    `json:"state"`
	IsShared  bool      `json:"isShared"`
	CreatedBy createdBy `json:"createdBy"`
}

// GET /api/planners/{plannerID}/views
// Returns the current user's own views + all is_shared=1 views from others.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	plannerID, ok := plannerIDFromPath(r)
	if !ok {
		jsonError(w, http.StatusBadRequest, "Invalid planner ID")
		return
	}
	userID := middleware.UserFrom(r).ID

	if _, err := middleware.CanAccess(r.Context(), h.db, plannerID, userID, "view"); err != nil {
		handleAccessErr(w, err)
		return
	}

	rows, err := h.db.QueryContext(r.Context(), h.db.Rebind(`
		SELECT sv.id, sv.name, sv.state, sv.is_shared,
		       u.id AS creator_id, u.username, COALESCE(u.full_name, '') AS full_name
		FROM saved_views sv
		JOIN users u ON u.id = sv.user_id
		WHERE sv.planner_id = ?
		  AND (sv.user_id = ? OR sv.is_shared = 1)
		ORDER BY sv.id DESC
	`), plannerID, userID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	defer rows.Close()

	var result []savedView
	for rows.Next() {
		var v savedView
		var isSharedInt int
		if err := rows.Scan(&v.ID, &v.Name, &v.State, &isSharedInt,
			&v.CreatedBy.ID, &v.CreatedBy.Username, &v.CreatedBy.FullName); err != nil {
			continue
		}
		v.IsShared = isSharedInt == 1
		result = append(result, v)
	}
	if result == nil {
		result = []savedView{}
	}
	writeJSON(w, http.StatusOK, result)
}

// POST /api/planners/{plannerID}/views
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	plannerID, ok := plannerIDFromPath(r)
	if !ok {
		jsonError(w, http.StatusBadRequest, "Invalid planner ID")
		return
	}
	userID := middleware.UserFrom(r).ID

	if _, err := middleware.CanAccess(r.Context(), h.db, plannerID, userID, "view"); err != nil {
		handleAccessErr(w, err)
		return
	}

	var body struct {
		Name     string `json:"name"`
		State    string `json:"state"`
		IsShared bool   `json:"isShared"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}

	if len(body.Name) == 0 || len(body.Name) > 120 {
		jsonError(w, http.StatusBadRequest, "name must be 1–120 characters")
		return
	}
	if len(body.State) == 0 || len(body.State) > 4096 {
		jsonError(w, http.StatusBadRequest, "state must be 1–4096 characters")
		return
	}

	// Only the planner owner may create shared views.
	if body.IsShared {
		var ownerID int
		err := h.db.QueryRowContext(r.Context(),
			h.db.Rebind("SELECT owner_id FROM planners WHERE id = ?"), plannerID,
		).Scan(&ownerID)
		if err != nil || ownerID != userID {
			jsonError(w, http.StatusForbidden, "Only the planner owner can publish shared views")
			return
		}
	}

	isSharedInt := 0
	if body.IsShared {
		isSharedInt = 1
	}

	var newID int64
	err := h.db.QueryRowContext(r.Context(), h.db.Rebind(`
		INSERT INTO saved_views (planner_id, user_id, name, state, is_shared)
		VALUES (?, ?, ?, ?, ?)
		RETURNING id
	`), plannerID, userID, body.Name, body.State, isSharedInt).Scan(&newID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	writeJSON(w, http.StatusCreated, map[string]int64{"id": newID})
}

// DELETE /api/planners/{plannerID}/views/{viewID}
// Owner-of-view OR planner-owner can delete.
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	plannerID, ok := plannerIDFromPath(r)
	if !ok {
		jsonError(w, http.StatusBadRequest, "Invalid planner ID")
		return
	}
	userID := middleware.UserFrom(r).ID

	if _, err := middleware.CanAccess(r.Context(), h.db, plannerID, userID, "view"); err != nil {
		handleAccessErr(w, err)
		return
	}

	viewID, err := strconv.Atoi(r.PathValue("viewID"))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid view ID")
		return
	}

	// Fetch the view to check ownership.
	var viewUserID int
	err = h.db.QueryRowContext(r.Context(),
		h.db.Rebind("SELECT user_id FROM saved_views WHERE id = ? AND planner_id = ?"),
		viewID, plannerID,
	).Scan(&viewUserID)
	if errors.Is(err, sql.ErrNoRows) {
		jsonError(w, http.StatusNotFound, "View not found")
		return
	}
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	// Must be view owner or planner owner.
	if viewUserID != userID {
		var plannerOwnerID int
		_ = h.db.QueryRowContext(r.Context(),
			h.db.Rebind("SELECT owner_id FROM planners WHERE id = ?"), plannerID,
		).Scan(&plannerOwnerID)
		if plannerOwnerID != userID {
			jsonError(w, http.StatusForbidden, "Only the view owner or planner owner can delete this view")
			return
		}
	}

	_, err = h.db.ExecContext(r.Context(),
		h.db.Rebind("DELETE FROM saved_views WHERE id = ? AND planner_id = ?"),
		viewID, plannerID,
	)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}
