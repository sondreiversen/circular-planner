package planners

import (
	"net/http"

	"planner/internal/middleware"
)

// member is the JSON shape returned by GET /api/planners/{id}/members.
type member struct {
	ID       int    `json:"id"`
	Username string `json:"username"`
	FullName string `json:"fullName,omitempty"`
	Role     string `json:"role"`
}

// Members handles GET /api/planners/{id}/members.
//
// Returns every person with access to the planner: the owner first (role
// "owner"), then all sharees ordered by username (role "edit" or "view").
// Requires at least view-level access.
func (h *Handler) Members(w http.ResponseWriter, r *http.Request) {
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

	// Single query: owner row UNION sharees.
	// The CASE puts the owner first (sort key 0) and sharees second (sort key 1).
	rows, err := h.db.QueryContext(r.Context(), h.db.Rebind(`
		SELECT u.id,
		       u.username,
		       COALESCE(NULLIF(u.full_name,''), '') AS full_name,
		       CASE WHEN p.owner_id = u.id THEN 'owner' ELSE ps.permission END AS role
		FROM planners p
		LEFT JOIN planner_shares ps ON ps.planner_id = p.id
		JOIN users u ON u.id = COALESCE(ps.user_id, p.owner_id)
		WHERE p.id = ?
		ORDER BY (CASE WHEN p.owner_id = u.id THEN 0 ELSE 1 END), u.username
	`), plannerID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	defer rows.Close()

	result := make([]member, 0)
	for rows.Next() {
		var m member
		if err := rows.Scan(&m.ID, &m.Username, &m.FullName, &m.Role); err != nil {
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
		result = append(result, m)
	}
	if err := rows.Err(); err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusOK, result)
}
