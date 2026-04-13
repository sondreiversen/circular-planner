package middleware

import (
	"context"
	"fmt"

	"planner/internal/db"
)

// AccessError is returned by CanAccess when the user lacks permission.
type AccessError struct {
	Status  int
	Message string
}

func (e *AccessError) Error() string { return fmt.Sprintf("%d: %s", e.Status, e.Message) }

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

	var perm string
	err = database.QueryRowContext(ctx,
		database.Rebind("SELECT permission FROM planner_shares WHERE planner_id = ? AND user_id = ?"),
		plannerID, userID,
	).Scan(&perm)
	if err != nil {
		return "", &AccessError{Status: 403, Message: "Access denied"}
	}

	if require == "edit" && perm != "edit" {
		return "", &AccessError{Status: 403, Message: "Edit access required"}
	}
	return perm, nil
}
