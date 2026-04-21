package middleware

import (
	"context"

	"planner/internal/db"
)

// AccessError is returned by CanAccess when the user lacks permission.
type AccessError struct {
	Status  int
	Message string
}

func (e *AccessError) Error() string {
	return e.Message
}

// CanAccess checks whether userID has at least the required permission on
// plannerId. It returns the resolved level ("owner","edit","view") or an
// *AccessError with the appropriate HTTP status.
func CanAccess(ctx context.Context, database *db.DB, plannerID, userID int, require string) (string, error) {
	var ownerID int
	err := database.QueryRowContext(ctx,
		database.Rebind("SELECT owner_id FROM planners WHERE id = ?"), plannerID,
	).Scan(&ownerID)
	if err != nil {
		return "", &AccessError{Status: 404, Message: "Planner not found"}
	}

	if ownerID == userID {
		return "owner", nil
	}
	if require == "owner" {
		return "", &AccessError{Status: 403, Message: "Only the owner can do this"}
	}

	// Direct per-user share
	var perm string
	err = database.QueryRowContext(ctx,
		database.Rebind("SELECT permission FROM planner_shares WHERE planner_id = ? AND user_id = ?"),
		plannerID, userID,
	).Scan(&perm)
	if err == nil {
		if perm != "view" && perm != "edit" {
			return "", &AccessError{Status: 500, Message: "Invalid permission value in database"}
		}
		if require == "edit" && perm != "edit" {
			return "", &AccessError{Status: 403, Message: "Edit access required"}
		}
		return perm, nil
	}

	// Group-based access: find best permission across all groups the user belongs to.
	// COALESCE prefers per-member override over the group default.
	rows, qErr := database.QueryContext(ctx,
		database.Rebind(`SELECT COALESCE(pgmo.permission, pgs.default_permission) AS permission
		FROM planner_group_shares pgs
		JOIN group_members gm ON gm.group_id = pgs.group_id AND gm.user_id = ?
		LEFT JOIN planner_group_member_overrides pgmo
		  ON pgmo.planner_id = pgs.planner_id
		 AND pgmo.group_id   = pgs.group_id
		 AND pgmo.user_id    = ?
		WHERE pgs.planner_id = ?`),
		userID, userID, plannerID,
	)
	if qErr == nil {
		defer rows.Close()
		var best string
		for rows.Next() {
			var p string
			if scanErr := rows.Scan(&p); scanErr != nil {
				continue
			}
			if p == "edit" {
				best = "edit"
			} else if best == "" {
				best = "view"
			}
		}
		if best != "" {
			if require == "edit" && best != "edit" {
				return "", &AccessError{Status: 403, Message: "Edit access required"}
			}
			return best, nil
		}
	}

	return "", &AccessError{Status: 403, Message: "Access denied"}
}
