// Package planners implements /api/planners/* routes.
package planners

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"planner/internal/config"
	"planner/internal/db"
	"planner/internal/middleware"
)

// Handler handles /api/planners/* requests.
type Handler struct {
	db  *db.DB
	cfg *config.Config
}

func NewHandler(database *db.DB, cfg *config.Config) *Handler {
	return &Handler{db: database, cfg: cfg}
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

func handleAccessErr(w http.ResponseWriter, err error) {
	if ae, ok := err.(*middleware.AccessError); ok {
		jsonError(w, ae.Status, ae.Message)
		return
	}
	jsonError(w, http.StatusInternalServerError, "Internal server error")
}

func plannerIDFromPath(r *http.Request) (int, bool) {
	id, err := strconv.Atoi(r.PathValue("id"))
	return id, err == nil
}

// --- GET /api/planners ---

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserFrom(r).ID
	rows, err := h.db.QueryContext(r.Context(), h.db.Rebind(`
		SELECT p.id, p.title, p.start_date, p.end_date, p.owner_id,
		       u.username AS owner_username,
		       CASE WHEN p.owner_id = ? THEN 'owner' ELSE ps.permission END AS permission
		FROM planners p
		JOIN users u ON u.id = p.owner_id
		LEFT JOIN planner_shares ps ON ps.planner_id = p.id AND ps.user_id = ?
		WHERE p.owner_id = ? OR ps.user_id = ?
		ORDER BY p.updated_at DESC
	`), userID, userID, userID, userID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	defer rows.Close()

	type row struct {
		ID            int
		Title         string
		StartDate     db.DateStr
		EndDate       db.DateStr
		OwnerID       int
		OwnerUsername string
		Permission    string
	}

	var result []map[string]any
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.ID, &r.Title, &r.StartDate, &r.EndDate,
			&r.OwnerID, &r.OwnerUsername, &r.Permission); err != nil {
			continue
		}
		result = append(result, map[string]any{
			"id":        r.ID,
			"title":     r.Title,
			"startDate": r.StartDate.String(),
			"endDate":   r.EndDate.String(),
			"isOwner":   r.OwnerID == userID,
			"permission": r.Permission,
			"ownerName": r.OwnerUsername,
		})
	}
	if result == nil {
		result = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, result)
}

// --- POST /api/planners ---

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserFrom(r).ID
	var body struct {
		Title     string `json:"title"`
		StartDate string `json:"startDate"`
		EndDate   string `json:"endDate"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	if body.Title == "" || body.StartDate == "" || body.EndDate == "" {
		jsonError(w, http.StatusBadRequest, "title, startDate and endDate are required")
		return
	}

	var id int
	var title string
	var startDate, endDate db.DateStr
	err := h.db.QueryRowContext(r.Context(),
		h.db.Rebind(`INSERT INTO planners(owner_id, title, start_date, end_date)
		             VALUES (?, ?, ?, ?) RETURNING id, title, start_date, end_date`),
		userID, body.Title, body.StartDate, body.EndDate,
	).Scan(&id, &title, &startDate, &endDate)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":        id,
		"title":     title,
		"startDate": startDate.String(),
		"endDate":   endDate.String(),
	})
}

// --- GET /api/planners/{id} ---

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
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

	// Fetch planner
	var ownerID int
	var title string
	var startDate, endDate db.DateStr
	err := h.db.QueryRowContext(r.Context(),
		h.db.Rebind("SELECT owner_id, title, start_date, end_date FROM planners WHERE id = ?"),
		plannerID,
	).Scan(&ownerID, &title, &startDate, &endDate)
	if err != nil {
		jsonError(w, http.StatusNotFound, "Planner not found")
		return
	}

	// Fetch lanes
	laneRows, err := h.db.QueryContext(r.Context(),
		h.db.Rebind("SELECT id, name, sort_order, color FROM lanes WHERE planner_id = ? ORDER BY sort_order"),
		plannerID,
	)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	defer laneRows.Close()

	type lane struct {
		ID         string
		Name       string
		Order      int
		Color      string
		Activities []map[string]any
	}
	laneMap := map[string]*lane{}
	var laneOrder []string
	for laneRows.Next() {
		var l lane
		if err := laneRows.Scan(&l.ID, &l.Name, &l.Order, &l.Color); err != nil {
			continue
		}
		l.Activities = []map[string]any{}
		laneMap[l.ID] = &l
		laneOrder = append(laneOrder, l.ID)
	}

	// Fetch activities
	actRows, err := h.db.QueryContext(r.Context(),
		h.db.Rebind("SELECT id, lane_id, title, description, start_date, end_date, color, label FROM activities WHERE planner_id = ?"),
		plannerID,
	)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	defer actRows.Close()

	for actRows.Next() {
		var id, laneID, title, description, color, label string
		var startDate, endDate db.DateStr
		if err := actRows.Scan(&id, &laneID, &title, &description, &startDate, &endDate, &color, &label); err != nil {
			continue
		}
		if l, ok := laneMap[laneID]; ok {
			l.Activities = append(l.Activities, map[string]any{
				"id":          id,
				"laneId":      laneID,
				"title":       title,
				"description": description,
				"startDate":   startDate.String(),
				"endDate":     endDate.String(),
				"color":       color,
				"label":       label,
			})
		}
	}

	lanesJSON := make([]map[string]any, 0, len(laneOrder))
	for _, lid := range laneOrder {
		l := laneMap[lid]
		lanesJSON = append(lanesJSON, map[string]any{
			"id":         l.ID,
			"name":       l.Name,
			"order":      l.Order,
			"color":      l.Color,
			"activities": l.Activities,
		})
	}

	perm := "edit"
	if ownerID == userID {
		perm = "owner"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"config": map[string]any{
			"plannerId": plannerID,
			"title":     title,
			"startDate": startDate.String(),
			"endDate":   endDate.String(),
			"isOwner":   ownerID == userID,
			"permission": perm,
		},
		"data": map[string]any{"lanes": lanesJSON},
	})
}

// --- PUT /api/planners/{id} ---

type activityInput struct {
	ID          string `json:"id"`
	LaneID      string `json:"laneId"`
	Title       string `json:"title"`
	Description string `json:"description"`
	StartDate   string `json:"startDate"`
	EndDate     string `json:"endDate"`
	Color       string `json:"color"`
	Label       string `json:"label"`
}

type laneInput struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Order      int             `json:"order"`
	Color      string          `json:"color"`
	Activities []activityInput `json:"activities"`
}

type putBody struct {
	Title     *string     `json:"title"`
	StartDate *string     `json:"startDate"`
	EndDate   *string     `json:"endDate"`
	Lanes     []laneInput `json:"lanes"`
}

func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	plannerID, ok := plannerIDFromPath(r)
	if !ok {
		jsonError(w, http.StatusBadRequest, "Invalid planner ID")
		return
	}
	userID := middleware.UserFrom(r).ID

	if _, err := middleware.CanAccess(r.Context(), h.db, plannerID, userID, "edit"); err != nil {
		handleAccessErr(w, err)
		return
	}

	var body putBody
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}

	tx, err := h.db.BeginTx(r.Context(), nil)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	defer tx.Rollback()

	// Update planner metadata if provided
	if body.Title != nil || body.StartDate != nil || body.EndDate != nil {
		// Build dynamic update
		var sets []string
		var args []any
		if body.Title != nil {
			sets = append(sets, "title = ?")
			args = append(args, *body.Title)
		}
		if body.StartDate != nil {
			sets = append(sets, "start_date = ?")
			args = append(args, *body.StartDate)
		}
		if body.EndDate != nil {
			sets = append(sets, "end_date = ?")
			args = append(args, *body.EndDate)
		}
		sets = append(sets, "updated_at = "+nowExpr(h.db))
		args = append(args, plannerID)

		q := h.db.Rebind("UPDATE planners SET " + strings.Join(sets, ", ") + " WHERE id = ?")
		if _, err := tx.ExecContext(r.Context(), q, args...); err != nil {
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
	}

	if body.Lanes != nil {
		// Collect IDs
		laneIDs := make([]string, len(body.Lanes))
		for i, l := range body.Lanes {
			laneIDs[i] = l.ID
		}

		// Delete lanes not in incoming set
		if err := deleteNotIn(r.Context(), tx, h.db, "lanes", "planner_id", plannerID, laneIDs); err != nil {
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}

		// Collect all activities
		var allActivities []activityInput
		var actIDs []string
		for _, l := range body.Lanes {
			// Upsert lane
			if _, err := tx.ExecContext(r.Context(), h.db.Rebind(`
				INSERT INTO lanes(id, planner_id, name, sort_order, color)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(id, planner_id) DO UPDATE
				  SET name = excluded.name, sort_order = excluded.sort_order, color = excluded.color
			`), l.ID, plannerID, l.Name, l.Order, l.Color); err != nil {
				jsonError(w, http.StatusInternalServerError, "Internal server error")
				return
			}
			for _, a := range l.Activities {
				allActivities = append(allActivities, a)
				actIDs = append(actIDs, a.ID)
			}
		}

		// Delete activities not in incoming set
		if err := deleteNotIn(r.Context(), tx, h.db, "activities", "planner_id", plannerID, actIDs); err != nil {
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}

		// Upsert activities
		for _, a := range allActivities {
			desc := a.Description
			label := a.Label
			if _, err := tx.ExecContext(r.Context(), h.db.Rebind(`
				INSERT INTO activities(id, lane_id, planner_id, title, description, start_date, end_date, color, label)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id, planner_id) DO UPDATE
				  SET lane_id = excluded.lane_id, title = excluded.title,
				      description = excluded.description, start_date = excluded.start_date,
				      end_date = excluded.end_date, color = excluded.color, label = excluded.label
			`), a.ID, a.LaneID, plannerID, a.Title, desc, a.StartDate, a.EndDate, a.Color, label); err != nil {
				jsonError(w, http.StatusInternalServerError, "Internal server error")
				return
			}
		}
	}

	if err := tx.Commit(); err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// --- DELETE /api/planners/{id} ---

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

	if _, err := h.db.ExecContext(r.Context(),
		h.db.Rebind("DELETE FROM planners WHERE id = ?"), plannerID); err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// --- helpers ---

// deleteNotIn deletes rows from table where pkCol = plannerID AND id NOT IN ids.
func deleteNotIn(ctx context.Context, tx *sql.Tx, database *db.DB, table, pkCol string, plannerID int, ids []string) error {
	if len(ids) == 0 {
		_, err := tx.ExecContext(ctx, database.Rebind("DELETE FROM "+table+" WHERE "+pkCol+" = ?"), plannerID)
		return err
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, 0, 1+len(ids))
	args = append(args, plannerID)
	for _, id := range ids {
		args = append(args, id)
	}
	q := database.Rebind("DELETE FROM " + table + " WHERE " + pkCol + " = ? AND id NOT IN (" + placeholders + ")")
	_, err := tx.ExecContext(ctx, q, args...)
	return err
}

// nowExpr returns the SQL expression for the current timestamp for the dialect.
func nowExpr(database *db.DB) string {
	if database.Dialect == db.Postgres {
		return "NOW()"
	}
	return "(strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
}
