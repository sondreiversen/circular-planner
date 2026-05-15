// Package search implements the GET /api/search route.
package search

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"planner/internal/db"
	"planner/internal/middleware"
)

// Handler handles /api/search requests.
type Handler struct {
	db *db.DB
}

// New creates a Handler backed by the given database.
func New(database *db.DB) *Handler {
	return &Handler{db: database}
}

// Register wires the route onto mux.
func (h *Handler) Register(mux *http.ServeMux, auth func(http.HandlerFunc) http.HandlerFunc) {
	mux.HandleFunc("GET /api/search", auth(h.Search))
}

type result struct {
	Kind          string `json:"kind"` // "activity" or "planner"
	ActivityID    string `json:"activityId,omitempty"`
	ActivityTitle string `json:"activityTitle,omitempty"`
	StartDate     string `json:"startDate,omitempty"`
	EndDate       string `json:"endDate,omitempty"`
	LaneID        string `json:"laneId,omitempty"`
	LaneName      string `json:"laneName,omitempty"`
	PlannerID     int    `json:"plannerId"`
	PlannerTitle  string `json:"plannerTitle"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// Search handles GET /api/search?q=...&limit=...
func (h *Handler) Search(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(strings.ToLower(r.URL.Query().Get("q")))
	if len(q) < 2 {
		writeJSON(w, http.StatusOK, map[string]any{"results": []result{}})
		return
	}

	limit := 50
	if ls := r.URL.Query().Get("limit"); ls != "" {
		if n, err := strconv.Atoi(ls); err == nil {
			if n < 1 {
				limit = 1
			} else if n > 100 {
				limit = 100
			} else {
				limit = n
			}
		}
	}

	pattern := "%" + q + "%"
	userID := middleware.UserFrom(r).ID

	// The ACL clause mirrors the List handler: owner OR direct planner_share OR
	// group membership via planner_group_shares.
	// is_public planners are included (a user who can see a public planner in
	// Discover should also be able to search it; this mirrors ListPublic behaviour).
	const aclClause = `(
		p.owner_id = ?
		OR EXISTS (SELECT 1 FROM planner_shares ps WHERE ps.planner_id = p.id AND ps.user_id = ?)
		OR EXISTS (
			SELECT 1 FROM planner_group_shares pgs
			JOIN group_members gm ON gm.group_id = pgs.group_id
			WHERE pgs.planner_id = p.id AND gm.user_id = ?
		)
		OR p.is_public = 1
	)`

	query := h.db.Rebind(`
		SELECT 'activity' AS kind,
		       a.id AS activity_id, a.title AS activity_title,
		       a.start_date, a.end_date,
		       a.lane_id, l.name AS lane_name,
		       p.id AS planner_id, p.title AS planner_title
		FROM activities a
		JOIN planners p ON p.id = a.planner_id
		JOIN lanes l ON l.id = a.lane_id AND l.planner_id = a.planner_id
		WHERE ` + aclClause + `
		  AND LOWER(a.title) LIKE ?
		UNION ALL
		SELECT 'planner' AS kind,
		       '' AS activity_id, '' AS activity_title,
		       '' AS start_date, '' AS end_date,
		       '' AS lane_id, '' AS lane_name,
		       p.id AS planner_id, p.title AS planner_title
		FROM planners p
		WHERE ` + aclClause + `
		  AND LOWER(p.title) LIKE ?
		LIMIT ?
	`)

	// Args: activity ACL (3× userID) + activity pattern, planner ACL (3× userID) + planner pattern, limit
	args := []any{
		userID, userID, userID, pattern,
		userID, userID, userID, pattern,
		limit,
	}

	rows, err := h.db.QueryContext(r.Context(), query, args...)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error"})
		return
	}
	defer rows.Close()

	results := []result{}
	for rows.Next() {
		var res result
		var startDate, endDate db.DateStr
		if err := rows.Scan(
			&res.Kind,
			&res.ActivityID, &res.ActivityTitle,
			&startDate, &endDate,
			&res.LaneID, &res.LaneName,
			&res.PlannerID, &res.PlannerTitle,
		); err != nil {
			continue
		}
		if res.Kind == "activity" {
			res.StartDate = startDate.String()
			res.EndDate = endDate.String()
		}
		results = append(results, res)
	}

	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}
