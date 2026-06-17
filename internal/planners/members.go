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

	// CTE collects all (user_id, role) pairs from three sources:
	//   1. the planner owner
	//   2. direct planner_shares
	//   3. group-share members (via planner_group_shares → group_members)
	// Dedup by user_id keeping the strongest role: 'owner' < 'edit' < 'view' lexicographically,
	// so MIN(role) gives the strongest (owner beats edit beats view).
	rows, err := h.db.QueryContext(r.Context(), h.db.Rebind(`
		SELECT u.id,
		       u.username,
		       COALESCE(NULLIF(u.full_name,''), '') AS full_name,
		       MIN(src.role) AS role
		FROM (
		  SELECT p.owner_id AS uid, 'owner' AS role
		  FROM planners p
		  WHERE p.id = ?
		  UNION ALL
		  SELECT ps.user_id, ps.permission
		  FROM planner_shares ps
		  WHERE ps.planner_id = ?
		  UNION ALL
		  SELECT gm.user_id, pgs.default_permission
		  FROM planner_group_shares pgs
		  JOIN group_members gm ON gm.group_id = pgs.group_id
		  WHERE pgs.planner_id = ?
		) src
		JOIN users u ON u.id = src.uid
		GROUP BY u.id, u.username, u.full_name
		ORDER BY MIN(CASE WHEN src.role = 'owner' THEN 0 ELSE 1 END), u.username
	`), plannerID, plannerID, plannerID)
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
