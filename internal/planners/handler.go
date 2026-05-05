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
		       COALESCE(NULLIF(u.full_name, ''), u.username) AS owner_username,
		       CASE
		         WHEN p.owner_id = ? THEN 'owner'
		         WHEN ps.permission = 'edit' OR gp.has_edit = 1 THEN 'edit'
		         ELSE 'view'
		       END AS permission,
		       p.is_public
		FROM planners p
		JOIN users u ON u.id = p.owner_id
		LEFT JOIN planner_shares ps
		       ON ps.planner_id = p.id AND ps.user_id = ?
		LEFT JOIN (
		  SELECT pgs.planner_id,
		         MAX(CASE WHEN COALESCE(pgmo.permission, pgs.default_permission) = 'edit'
		                  THEN 1 ELSE 0 END) AS has_edit
		  FROM planner_group_shares pgs
		  JOIN group_members gm
		    ON gm.group_id = pgs.group_id AND gm.user_id = ?
		  LEFT JOIN planner_group_member_overrides pgmo
		    ON pgmo.planner_id = pgs.planner_id
		   AND pgmo.group_id   = pgs.group_id
		   AND pgmo.user_id    = ?
		  GROUP BY pgs.planner_id
		) gp ON gp.planner_id = p.id
		WHERE p.owner_id = ?
		   OR ps.user_id = ?
		   OR gp.planner_id IS NOT NULL
		ORDER BY p.updated_at DESC
	`), userID, userID, userID, userID, userID, userID)
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
		IsPublic      int
	}

	var result []map[string]any
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.ID, &r.Title, &r.StartDate, &r.EndDate,
			&r.OwnerID, &r.OwnerUsername, &r.Permission, &r.IsPublic); err != nil {
			continue
		}
		result = append(result, map[string]any{
			"id":         r.ID,
			"title":      r.Title,
			"startDate":  r.StartDate.String(),
			"endDate":    r.EndDate.String(),
			"isOwner":    r.OwnerID == userID,
			"permission": r.Permission,
			"ownerName":  r.OwnerUsername,
			"isPublic":   r.IsPublic == 1,
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
	var updatedAt string
	var isPublic int
	err := h.db.QueryRowContext(r.Context(),
		h.db.Rebind("SELECT owner_id, title, start_date, end_date, updated_at, is_public FROM planners WHERE id = ?"),
		plannerID,
	).Scan(&ownerID, &title, &startDate, &endDate, &updatedAt, &isPublic)
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

	// Fetch activities (LEFT JOIN users to get creator display name)
	actRows, err := h.db.QueryContext(r.Context(),
		h.db.Rebind(`SELECT a.id, a.lane_id, a.title, a.description, a.start_date, a.end_date,
		             a.color, a.label, a.recurrence_type, a.recurrence_interval, a.recurrence_weekdays, a.recurrence_until,
		             COALESCE(NULLIF(u.full_name, ''), u.username) AS created_by_name
		      FROM activities a
		      LEFT JOIN users u ON u.id = a.created_by
		      WHERE a.planner_id = ?`),
		plannerID,
	)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	defer actRows.Close()

	// activityByID maps activity ID → the map entry (for tag attachment after loop)
	activityByID := map[string]map[string]any{}

	for actRows.Next() {
		var id, laneID, title, description, color, label string
		var startDate, endDate db.DateStr
		var recType sql.NullString
		var recInterval sql.NullInt64
		var recWeekdays sql.NullString
		var recUntil sql.NullString
		var createdByName sql.NullString
		if err := actRows.Scan(&id, &laneID, &title, &description, &startDate, &endDate, &color, &label,
			&recType, &recInterval, &recWeekdays, &recUntil, &createdByName); err != nil {
			continue
		}
		act := map[string]any{
			"id":          id,
			"laneId":      laneID,
			"title":       title,
			"description": description,
			"startDate":   startDate.String(),
			"endDate":     endDate.String(),
			"color":       color,
			"label":       label,
		}
		if createdByName.Valid {
			act["createdBy"] = createdByName.String
		}
		if recType.Valid {
			rec := map[string]any{
				"type":     recType.String,
				"interval": int(recInterval.Int64),
			}
			if recWeekdays.Valid && recWeekdays.String != "" {
				rec["weekdays"] = parseWeekdaysCSV(recWeekdays.String)
			}
			if recUntil.Valid {
				rec["until"] = recUntil.String
			}
			act["recurrence"] = rec
		}
		activityByID[id] = act
		if l, ok := laneMap[laneID]; ok {
			l.Activities = append(l.Activities, act)
		}
	}

	// Fetch tagged users per activity for this planner
	tagRows, err := h.db.QueryContext(r.Context(),
		h.db.Rebind(`SELECT t.activity_id, u.id, u.username, COALESCE(NULLIF(u.full_name, ''), '') AS full_name
		      FROM activity_user_tags t JOIN users u ON u.id = t.user_id
		      WHERE t.planner_id = ?
		      ORDER BY u.username`),
		plannerID,
	)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	defer tagRows.Close()

	// tagsByActivity accumulates tagged user entries keyed by activity_id
	tagsByActivity := map[string][]map[string]any{}
	for tagRows.Next() {
		var activityID, username, fullName string
		var uid int
		if err := tagRows.Scan(&activityID, &uid, &username, &fullName); err != nil {
			continue
		}
		entry := map[string]any{
			"id":       uid,
			"username": username,
		}
		if fullName != "" {
			entry["fullName"] = fullName
		}
		tagsByActivity[activityID] = append(tagsByActivity[activityID], entry)
	}

	// Attach tagged users to activity maps (only when non-empty)
	for actID, tags := range tagsByActivity {
		if act, ok := activityByID[actID]; ok {
			act["taggedUsers"] = tags
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
			"plannerId":  plannerID,
			"title":      title,
			"startDate":  startDate.String(),
			"endDate":    endDate.String(),
			"isOwner":    ownerID == userID,
			"permission": perm,
			"updated_at": updatedAt,
			"isPublic":   isPublic == 1,
		},
		"data": map[string]any{"lanes": lanesJSON},
	})
}

// --- PUT /api/planners/{id} ---

type recurrenceInput struct {
	Type     string  `json:"type"`
	Interval int     `json:"interval"`
	Weekdays []int   `json:"weekdays,omitempty"`
	Until    *string `json:"until,omitempty"`
}

type activityInput struct {
	ID             string           `json:"id"`
	LaneID         string           `json:"laneId"`
	Title          string           `json:"title"`
	Description    string           `json:"description"`
	StartDate      string           `json:"startDate"`
	EndDate        string           `json:"endDate"`
	Color          string           `json:"color"`
	Label          string           `json:"label"`
	Recurrence     *recurrenceInput `json:"recurrence,omitempty"`
	TaggedUserIDs  []int            `json:"taggedUserIds"`
}

type laneInput struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Order      int             `json:"order"`
	Color      string          `json:"color"`
	Activities []activityInput `json:"activities"`
}

type putBody struct {
	Title           *string     `json:"title"`
	StartDate       *string     `json:"startDate"`
	EndDate         *string     `json:"endDate"`
	IsPublic        *bool       `json:"isPublic"`
	Lanes           []laneInput `json:"lanes"`
	ClientUpdatedAt string      `json:"client_updated_at"` // optional; ISO8601; 409 if stale
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

	var serverUpdatedAt string
	if err := tx.QueryRowContext(r.Context(),
		h.db.Rebind("SELECT updated_at FROM planners WHERE id = ?"), plannerID,
	).Scan(&serverUpdatedAt); err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	if body.ClientUpdatedAt != "" && body.ClientUpdatedAt != serverUpdatedAt {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":             "conflict",
			"server_updated_at": serverUpdatedAt,
		})
		return
	}

	// Update planner metadata if provided
	if body.Title != nil || body.StartDate != nil || body.EndDate != nil || body.IsPublic != nil {
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
		if body.IsPublic != nil {
			sets = append(sets, "is_public = ?")
			v := 0
			if *body.IsPublic {
				v = 1
			}
			args = append(args, v)
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
		incomingLaneIDs := make(map[string]struct{}, len(body.Lanes))
		laneIDs := make([]string, len(body.Lanes))
		for i, l := range body.Lanes {
			incomingLaneIDs[l.ID] = struct{}{}
			laneIDs[i] = l.ID
		}

		existingLaneRows, err := tx.QueryContext(r.Context(),
			h.db.Rebind("SELECT id FROM lanes WHERE planner_id = ?"), plannerID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
		var willDeleteLane bool
		for existingLaneRows.Next() {
			var eid string
			existingLaneRows.Scan(&eid)
			if _, ok := incomingLaneIDs[eid]; !ok {
				willDeleteLane = true
				break
			}
		}
		existingLaneRows.Close()

		// Also check activities.
		existingActRows, err := tx.QueryContext(r.Context(),
			h.db.Rebind("SELECT id FROM activities WHERE planner_id = ?"), plannerID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
		incomingActIDs := make(map[string]struct{})
		for _, l := range body.Lanes {
			for _, a := range l.Activities {
				incomingActIDs[a.ID] = struct{}{}
			}
		}
		var willDeleteAct bool
		for existingActRows.Next() {
			var eid string
			existingActRows.Scan(&eid)
			if _, ok := incomingActIDs[eid]; !ok {
				willDeleteAct = true
				break
			}
		}
		existingActRows.Close()

		if willDeleteLane || willDeleteAct {
			var ownerID int
			if err := tx.QueryRowContext(r.Context(),
				h.db.Rebind("SELECT owner_id FROM planners WHERE id = ?"), plannerID,
			).Scan(&ownerID); err != nil || ownerID != userID {
				jsonError(w, http.StatusForbidden, "only the owner can delete lanes or activities")
				return
			}
		}

		for _, l := range body.Lanes {
			for _, a := range l.Activities {
				if _, ok := incomingLaneIDs[a.LaneID]; !ok {
					jsonError(w, http.StatusBadRequest, "activity references unknown lane_id")
					return
				}
			}
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

			var recType, recWeekdays, recUntil sql.NullString
			var recInterval sql.NullInt64

			if a.Recurrence != nil {
				rec := a.Recurrence
				if rec.Type != "daily" && rec.Type != "weekly" {
					jsonError(w, http.StatusBadRequest, "recurrence.type must be 'daily' or 'weekly'")
					return
				}
				if rec.Interval < 1 {
					jsonError(w, http.StatusBadRequest, "recurrence.interval must be >= 1")
					return
				}
				if rec.Type == "weekly" && len(rec.Weekdays) == 0 {
					jsonError(w, http.StatusBadRequest, "recurrence.weekdays must not be empty for weekly recurrence")
					return
				}
				recType = sql.NullString{String: rec.Type, Valid: true}
				recInterval = sql.NullInt64{Int64: int64(rec.Interval), Valid: true}
				if len(rec.Weekdays) > 0 {
					recWeekdays = sql.NullString{String: formatWeekdaysCSV(rec.Weekdays), Valid: true}
				}
				if rec.Until != nil {
					recUntil = sql.NullString{String: *rec.Until, Valid: true}
				}
			}

			if _, err := tx.ExecContext(r.Context(), h.db.Rebind(`
				INSERT INTO activities(id, lane_id, planner_id, title, description, start_date, end_date, color, label, recurrence_type, recurrence_interval, recurrence_weekdays, recurrence_until, created_by)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id, planner_id) DO UPDATE
				  SET lane_id = excluded.lane_id, title = excluded.title,
				      description = excluded.description, start_date = excluded.start_date,
				      end_date = excluded.end_date, color = excluded.color, label = excluded.label,
				      recurrence_type = excluded.recurrence_type, recurrence_interval = excluded.recurrence_interval,
				      recurrence_weekdays = excluded.recurrence_weekdays, recurrence_until = excluded.recurrence_until
				      -- created_by deliberately excluded: original creator is preserved on update
			`), a.ID, a.LaneID, plannerID, a.Title, desc, a.StartDate, a.EndDate, a.Color, label,
				recType, recInterval, recWeekdays, recUntil, userID); err != nil {
				jsonError(w, http.StatusInternalServerError, "Internal server error")
				return
			}
		}

		// Sync activity_user_tags: replace all tags for this planner atomically.
		if _, err := tx.ExecContext(r.Context(),
			h.db.Rebind("DELETE FROM activity_user_tags WHERE planner_id = ?"), plannerID); err != nil {
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
		for _, l := range body.Lanes {
			for _, a := range l.Activities {
				seen := make(map[int]struct{}, len(a.TaggedUserIDs))
				for _, uid := range a.TaggedUserIDs {
					if uid <= 0 {
						continue
					}
					if _, dup := seen[uid]; dup {
						continue
					}
					seen[uid] = struct{}{}
					if _, err := tx.ExecContext(r.Context(), h.db.Rebind(
						"INSERT INTO activity_user_tags(activity_id, planner_id, user_id) VALUES (?, ?, ?)"),
						a.ID, plannerID, uid); err != nil {
						jsonError(w, http.StatusBadRequest, "invalid taggedUserIds")
						return
					}
				}
			}
		}

		// Always bump updated_at when lanes/activities change (even if metadata unchanged).
		if body.Title == nil && body.StartDate == nil && body.EndDate == nil {
			if _, err := tx.ExecContext(r.Context(),
				h.db.Rebind("UPDATE planners SET updated_at = "+nowExpr(h.db)+" WHERE id = ?"),
				plannerID); err != nil {
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
		if !middleware.UserFrom(r).IsAdmin {
			handleAccessErr(w, err)
			return
		}
		// Admin override: confirm planner exists; otherwise CanAccess's 404 was correct.
		var n int
		_ = h.db.QueryRowContext(r.Context(),
			h.db.Rebind("SELECT COUNT(*) FROM planners WHERE id = ?"), plannerID).Scan(&n)
		if n == 0 {
			jsonError(w, http.StatusNotFound, "Planner not found")
			return
		}
	}

	if _, err := h.db.ExecContext(r.Context(),
		h.db.Rebind("DELETE FROM planners WHERE id = ?"), plannerID); err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// --- GET /api/planners/public ---

// ListPublic returns all public planners that the authenticated user does not
// already own or have direct/group-share access to (those appear in List).
func (h *Handler) ListPublic(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserFrom(r).ID
	rows, err := h.db.QueryContext(r.Context(), h.db.Rebind(`
		SELECT p.id, p.title, p.start_date, p.end_date, p.owner_id,
		       COALESCE(NULLIF(u.full_name,''), u.username) AS owner_username
		FROM planners p
		JOIN users u ON u.id = p.owner_id
		WHERE p.is_public = 1
		  AND p.owner_id != ?
		  AND NOT EXISTS (SELECT 1 FROM planner_shares s WHERE s.planner_id = p.id AND s.user_id = ?)
		  AND NOT EXISTS (
		    SELECT 1 FROM planner_group_shares gs
		    JOIN group_members gm ON gm.group_id = gs.group_id
		    WHERE gs.planner_id = p.id AND gm.user_id = ?)
		ORDER BY p.updated_at DESC
		LIMIT 100
	`), userID, userID, userID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	defer rows.Close()

	var result []map[string]any
	for rows.Next() {
		var id int
		var title string
		var startDate, endDate db.DateStr
		var ownerID int
		var ownerUsername string
		if err := rows.Scan(&id, &title, &startDate, &endDate, &ownerID, &ownerUsername); err != nil {
			continue
		}
		result = append(result, map[string]any{
			"id":         id,
			"title":      title,
			"startDate":  startDate.String(),
			"endDate":    endDate.String(),
			"isOwner":    false,
			"permission": "view",
			"ownerName":  ownerUsername,
			"isPublic":   true,
		})
	}
	if result == nil {
		result = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, result)
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

// formatWeekdaysCSV serializes a slice of weekday ints to a CSV string like "1,3,5".
func formatWeekdaysCSV(days []int) string {
	parts := make([]string, len(days))
	for i, d := range days {
		parts[i] = strconv.Itoa(d)
	}
	return strings.Join(parts, ",")
}

// parseWeekdaysCSV deserializes a CSV string like "1,3,5" to a slice of ints.
func parseWeekdaysCSV(csv string) []int {
	parts := strings.Split(csv, ",")
	result := make([]int, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if n, err := strconv.Atoi(p); err == nil {
			result = append(result, n)
		}
	}
	return result
}
