// Package planners implements /api/planners/* routes.
package planners

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"planner/internal/config"
	"planner/internal/db"
	"planner/internal/middleware"
)

var usernameRE = regexp.MustCompile(`^[a-zA-Z0-9_.\-]{1,50}$`)

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

	accessLevel, err := middleware.CanAccess(r.Context(), h.db, plannerID, userID, "view")
	if err != nil {
		handleAccessErr(w, err)
		return
	}

	// Fetch planner
	var ownerID int
	var title string
	var startDate, endDate db.DateStr
	var updatedAt string
	var isPublic int
	err = h.db.QueryRowContext(r.Context(),
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
		             COALESCE(NULLIF(u.full_name, ''), u.username) AS created_by_name,
		             a.status, a.is_milestone,
		             a.recurrence_monthly_rule, a.recurrence_exceptions, a.recurrence_overrides
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
		var status string
		var isMilestone int
		var recMonthlyRule sql.NullString
		var recExceptions sql.NullString
		var recOverrides sql.NullString
		if err := actRows.Scan(&id, &laneID, &title, &description, &startDate, &endDate, &color, &label,
			&recType, &recInterval, &recWeekdays, &recUntil, &createdByName, &status, &isMilestone,
			&recMonthlyRule, &recExceptions, &recOverrides); err != nil {
			continue
		}
		if status == "" {
			status = "planned"
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
			"status":      status,
		}
		if isMilestone != 0 {
			act["isMilestone"] = true
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
			if recMonthlyRule.Valid && recMonthlyRule.String != "" {
				if mr := parseMonthlyRule(recMonthlyRule.String); mr != nil {
					rec["monthlyRule"] = mr
				}
			}
			if recExceptions.Valid && recExceptions.String != "" {
				var excs []string
				if err := json.Unmarshal([]byte(recExceptions.String), &excs); err == nil && len(excs) > 0 {
					rec["exceptions"] = excs
				}
			}
			if recOverrides.Valid && recOverrides.String != "" {
				var ovr map[string]map[string]any
				if err := json.Unmarshal([]byte(recOverrides.String), &ovr); err == nil && len(ovr) > 0 {
					rec["overrides"] = ovr
				}
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

	// Fetch pending tags for this planner
	pendingTagRows, err := h.db.QueryContext(r.Context(),
		h.db.Rebind("SELECT activity_id, username FROM activity_pending_tags WHERE planner_id = ? ORDER BY username"),
		plannerID,
	)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	defer pendingTagRows.Close()

	for pendingTagRows.Next() {
		var activityID, username string
		if err := pendingTagRows.Scan(&activityID, &username); err != nil {
			continue
		}
		tagsByActivity[activityID] = append(tagsByActivity[activityID], map[string]any{
			"id":       nil,
			"username": username,
			"pending":  true,
		})
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

	writeJSON(w, http.StatusOK, map[string]any{
		"config": map[string]any{
			"plannerId":  plannerID,
			"title":      title,
			"startDate":  startDate.String(),
			"endDate":    endDate.String(),
			"isOwner":    ownerID == userID,
			"permission": accessLevel,
			"updated_at": updatedAt,
			"isPublic":   isPublic == 1,
		},
		"data": map[string]any{"lanes": lanesJSON},
	})
}

// --- PUT /api/planners/{id} ---

type monthlyRuleInput struct {
	Kind    string `json:"kind"`    // "dom" or "nthwd"
	Day     int    `json:"day"`     // dom: 1..31
	Week    int    `json:"week"`    // nthwd: 1..5 or -1 (last)
	Weekday int    `json:"weekday"` // nthwd: 0..6 (Sun=0)
}

type recurrenceInput struct {
	Type        string                       `json:"type"`
	Interval    int                          `json:"interval"`
	Weekdays    []int                        `json:"weekdays,omitempty"`
	MonthlyRule *monthlyRuleInput            `json:"monthlyRule,omitempty"`
	Until       *string                      `json:"until,omitempty"`
	Exceptions  []string                     `json:"exceptions,omitempty"`
	Overrides   map[string]map[string]any    `json:"overrides,omitempty"`
}

type activityInput struct {
	ID               string           `json:"id"`
	LaneID           string           `json:"laneId"`
	Title            string           `json:"title"`
	Description      string           `json:"description"`
	StartDate        string           `json:"startDate"`
	EndDate          string           `json:"endDate"`
	Color            string           `json:"color"`
	Label            string           `json:"label"`
	Recurrence       *recurrenceInput `json:"recurrence,omitempty"`
	TaggedUserIDs    []int            `json:"taggedUserIds"`
	TaggedUsernames  []string         `json:"taggedUsernames,omitempty"`
	Status           string           `json:"status"`
	IsMilestone      bool             `json:"isMilestone"`
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

	r.Body = http.MaxBytesReader(w, r.Body, 5<<20)
	var body putBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
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
			if err := existingLaneRows.Scan(&eid); err != nil {
				existingLaneRows.Close()
				jsonError(w, http.StatusInternalServerError, "Internal server error")
				return
			}
			if _, ok := incomingLaneIDs[eid]; !ok {
				willDeleteLane = true
				break
			}
		}
		if err := existingLaneRows.Err(); err != nil {
			existingLaneRows.Close()
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
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
			if err := existingActRows.Scan(&eid); err != nil {
				existingActRows.Close()
				jsonError(w, http.StatusInternalServerError, "Internal server error")
				return
			}
			if _, ok := incomingActIDs[eid]; !ok {
				willDeleteAct = true
				break
			}
		}
		if err := existingActRows.Err(); err != nil {
			existingActRows.Close()
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
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

		// Upsert activities — validate recurrence fields first, then batch-insert.
		// Pre-process all activities into flat arg slices so we can chunk efficiently.
		type actRow struct {
			id              string
			laneID          string
			title           string
			desc            string
			startDate       string
			endDate         string
			color           string
			label           string
			recType         sql.NullString
			recInterval     sql.NullInt64
			recWeekdays     sql.NullString
			recUntil        sql.NullString
			createdBy       int
			status          string
			isMilestone     int
			recMonthlyRule  sql.NullString
			recExceptions   sql.NullString
			recOverrides    sql.NullString
		}
		actRows := make([]actRow, 0, len(allActivities))
		for _, a := range allActivities {
			var recType, recWeekdays, recUntil, recMonthlyRule, recExceptions, recOverrides sql.NullString
			var recInterval sql.NullInt64

			if a.Recurrence != nil {
				rec := a.Recurrence
				switch rec.Type {
				case "daily", "weekly", "monthly", "yearly":
					// valid
				default:
					jsonError(w, http.StatusBadRequest, "recurrence.type must be 'daily', 'weekly', 'monthly', or 'yearly'")
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
				if rec.Type == "monthly" {
					if rec.MonthlyRule == nil {
						jsonError(w, http.StatusBadRequest, "recurrence.monthlyRule is required for monthly recurrence")
						return
					}
					mr := rec.MonthlyRule
					switch mr.Kind {
					case "dom":
						if mr.Day < 1 || mr.Day > 31 {
							jsonError(w, http.StatusBadRequest, "monthlyRule.day must be 1..31")
							return
						}
						recMonthlyRule = sql.NullString{String: formatMonthlyRuleDOM(mr.Day), Valid: true}
					case "nthwd":
						validWeek := mr.Week == 1 || mr.Week == 2 || mr.Week == 3 || mr.Week == 4 || mr.Week == 5 || mr.Week == -1
						if !validWeek {
							jsonError(w, http.StatusBadRequest, "monthlyRule.week must be 1..5 or -1")
							return
						}
						if mr.Weekday < 0 || mr.Weekday > 6 {
							jsonError(w, http.StatusBadRequest, "monthlyRule.weekday must be 0..6")
							return
						}
						recMonthlyRule = sql.NullString{String: formatMonthlyRuleNthWd(mr.Week, mr.Weekday), Valid: true}
					default:
						jsonError(w, http.StatusBadRequest, "monthlyRule.kind must be 'dom' or 'nthwd'")
						return
					}
				}
				// Validate exceptions: each must match YYYY-MM-DD.
				for _, exc := range rec.Exceptions {
					if !isValidDate(exc) {
						jsonError(w, http.StatusBadRequest, "recurrence.exceptions entries must be YYYY-MM-DD")
						return
					}
				}
				if len(rec.Exceptions) > 0 {
					excJSON, err := json.Marshal(rec.Exceptions)
					if err != nil {
						jsonError(w, http.StatusInternalServerError, "Internal server error")
						return
					}
					recExceptions = sql.NullString{String: string(excJSON), Valid: true}
				}
				// Validate and serialise overrides.
				allowedOverrideKeys := map[string]bool{
					"title": true, "description": true, "startDate": true,
					"endDate": true, "color": true, "label": true, "status": true,
				}
				if len(rec.Overrides) > 0 {
					for dateKey, fields := range rec.Overrides {
						if !isValidDate(dateKey) {
							jsonError(w, http.StatusBadRequest, "recurrence.overrides keys must be YYYY-MM-DD")
							return
						}
						for k := range fields {
							if !allowedOverrideKeys[k] {
								jsonError(w, http.StatusBadRequest, "recurrence.overrides field '"+k+"' is not allowed")
								return
							}
						}
					}
					ovrJSON, err := json.Marshal(rec.Overrides)
					if err != nil {
						jsonError(w, http.StatusInternalServerError, "Internal server error")
						return
					}
					recOverrides = sql.NullString{String: string(ovrJSON), Valid: true}
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

			// Validate and default status.
			status := a.Status
			switch status {
			case "planned", "in_progress", "done", "cancelled":
				// valid
			default:
				status = "planned"
			}

			isMilestone := 0
			if a.IsMilestone {
				isMilestone = 1
			}

			actRows = append(actRows, actRow{
				id: a.ID, laneID: a.LaneID, title: a.Title, desc: a.Description,
				startDate: a.StartDate, endDate: a.EndDate, color: a.Color, label: a.Label,
				recType: recType, recInterval: recInterval, recWeekdays: recWeekdays, recUntil: recUntil,
				createdBy: userID, status: status, isMilestone: isMilestone,
				recMonthlyRule: recMonthlyRule, recExceptions: recExceptions, recOverrides: recOverrides,
			})
		}

		// Chunked multi-row INSERT ... ON CONFLICT DO UPDATE.
		// 50 rows × 19 cols = 950 placeholders — still under SQLite's 999 limit.
		const activityChunk = 50
		const activityOnConflict = `ON CONFLICT(id, planner_id) DO UPDATE
				  SET lane_id = excluded.lane_id, title = excluded.title,
				      description = excluded.description, start_date = excluded.start_date,
				      end_date = excluded.end_date, color = excluded.color, label = excluded.label,
				      recurrence_type = excluded.recurrence_type, recurrence_interval = excluded.recurrence_interval,
				      recurrence_weekdays = excluded.recurrence_weekdays, recurrence_until = excluded.recurrence_until,
				      status = excluded.status, is_milestone = excluded.is_milestone,
				      recurrence_monthly_rule = excluded.recurrence_monthly_rule,
				      recurrence_exceptions = excluded.recurrence_exceptions,
				      recurrence_overrides = excluded.recurrence_overrides`
		for start := 0; start < len(actRows); start += activityChunk {
			end := start + activityChunk
			if end > len(actRows) {
				end = len(actRows)
			}
			batch := actRows[start:end]
			ph := strings.TrimSuffix(strings.Repeat("(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?),", len(batch)), ",")
			args := make([]any, 0, len(batch)*19)
			for _, row := range batch {
				args = append(args, row.id, row.laneID, plannerID, row.title, row.desc,
					row.startDate, row.endDate, row.color, row.label,
					row.recType, row.recInterval, row.recWeekdays, row.recUntil, row.createdBy,
					row.status, row.isMilestone, row.recMonthlyRule, row.recExceptions, row.recOverrides)
			}
			q := h.db.Rebind(`INSERT INTO activities(id, lane_id, planner_id, title, description, start_date, end_date, color, label, recurrence_type, recurrence_interval, recurrence_weekdays, recurrence_until, created_by, status, is_milestone, recurrence_monthly_rule, recurrence_exceptions, recurrence_overrides) VALUES ` + ph + ` ` + activityOnConflict)
			if _, err := tx.ExecContext(r.Context(), q, args...); err != nil {
				jsonError(w, http.StatusInternalServerError, "Internal server error")
				return
			}
		}

		// Sync activity_user_tags: collect all (activity_id, user_id) triples,
		// deduplicate, then batch-insert after deleting all existing tags.
		type tagTriple struct {
			activityID string
			userID     int
		}
		var tagTriples []tagTriple
		tagSeen := make(map[string]struct{})
		for _, l := range body.Lanes {
			for _, a := range l.Activities {
				for _, uid := range a.TaggedUserIDs {
					if uid <= 0 {
						continue
					}
					key := a.ID + "|" + strconv.Itoa(uid)
					if _, dup := tagSeen[key]; dup {
						continue
					}
					tagSeen[key] = struct{}{}
					tagTriples = append(tagTriples, tagTriple{a.ID, uid})
				}
			}
		}

		// Collect pending tag usernames per activity; validate, then resolve what we can.
		type pendingTriple struct {
			activityID string
			username   string
		}
		var pendingTriples []pendingTriple
		pendingSeen := make(map[string]struct{})
		var allPendingUsernames []string
		pendingUsernameSet := make(map[string]struct{})

		for _, l := range body.Lanes {
			for _, a := range l.Activities {
				for _, uname := range a.TaggedUsernames {
					if !usernameRE.MatchString(uname) {
						jsonError(w, http.StatusBadRequest, "invalid taggedUsernames")
						return
					}
					key := a.ID + "|" + strings.ToLower(uname)
					if _, dup := pendingSeen[key]; dup {
						continue
					}
					pendingSeen[key] = struct{}{}
					pendingTriples = append(pendingTriples, pendingTriple{a.ID, uname})
					lname := strings.ToLower(uname)
					if _, seen := pendingUsernameSet[lname]; !seen {
						pendingUsernameSet[lname] = struct{}{}
						allPendingUsernames = append(allPendingUsernames, lname)
					}
				}
			}
		}

		// Resolve pending usernames that already have accounts.
		resolvedByLower := make(map[string]int) // lower(username) → user_id
		if len(allPendingUsernames) > 0 {
			ph := strings.TrimSuffix(strings.Repeat("?,", len(allPendingUsernames)), ",")
			args := make([]any, len(allPendingUsernames))
			for i, u := range allPendingUsernames {
				args[i] = u
			}
			resolveRows, err := tx.QueryContext(r.Context(),
				h.db.Rebind("SELECT id, LOWER(username) FROM users WHERE LOWER(username) IN ("+ph+")"),
				args...,
			)
			if err != nil {
				jsonError(w, http.StatusInternalServerError, "Internal server error")
				return
			}
			for resolveRows.Next() {
				var uid int
				var lname string
				if err := resolveRows.Scan(&uid, &lname); err != nil {
					continue
				}
				resolvedByLower[lname] = uid
			}
			resolveRows.Close()
		}

		// Move resolved pending entries into tagTriples; keep unresolved as pendingTriples.
		var stillPending []pendingTriple
		for _, pt := range pendingTriples {
			lname := strings.ToLower(pt.username)
			if uid, ok := resolvedByLower[lname]; ok {
				key := pt.activityID + "|" + strconv.Itoa(uid)
				if _, dup := tagSeen[key]; !dup {
					tagSeen[key] = struct{}{}
					tagTriples = append(tagTriples, tagTriple{pt.activityID, uid})
				}
			} else {
				stillPending = append(stillPending, pt)
			}
		}

		if _, err := tx.ExecContext(r.Context(),
			h.db.Rebind("DELETE FROM activity_user_tags WHERE planner_id = ?"), plannerID); err != nil {
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}

		// Chunked multi-row INSERT for tags.
		// 100 rows × 3 cols = 300 placeholders — well under SQLite's 999 limit.
		const tagChunk = 100
		for start := 0; start < len(tagTriples); start += tagChunk {
			end := start + tagChunk
			if end > len(tagTriples) {
				end = len(tagTriples)
			}
			batch := tagTriples[start:end]
			ph := strings.TrimSuffix(strings.Repeat("(?,?,?),", len(batch)), ",")
			args := make([]any, 0, len(batch)*3)
			for _, t := range batch {
				args = append(args, t.activityID, plannerID, t.userID)
			}
			q := h.db.Rebind("INSERT INTO activity_user_tags(activity_id, planner_id, user_id) VALUES " + ph)
			if _, err := tx.ExecContext(r.Context(), q, args...); err != nil {
				jsonError(w, http.StatusBadRequest, "invalid taggedUserIds")
				return
			}
		}

		// Sync activity_pending_tags: replace-style, same pattern as resolved tags.
		if _, err := tx.ExecContext(r.Context(),
			h.db.Rebind("DELETE FROM activity_pending_tags WHERE planner_id = ?"), plannerID); err != nil {
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}

		for start := 0; start < len(stillPending); start += tagChunk {
			end := start + tagChunk
			if end > len(stillPending) {
				end = len(stillPending)
			}
			batch := stillPending[start:end]
			ph := strings.TrimSuffix(strings.Repeat("(?,?,?),", len(batch)), ",")
			args := make([]any, 0, len(batch)*3)
			for _, pt := range batch {
				args = append(args, pt.activityID, plannerID, pt.username)
			}
			q := h.db.Rebind("INSERT INTO activity_pending_tags(activity_id, planner_id, username) VALUES " + ph)
			if _, err := tx.ExecContext(r.Context(), q, args...); err != nil {
				jsonError(w, http.StatusInternalServerError, "Internal server error")
				return
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

// --- POST /api/planners/{id}/duplicate ---

func (h *Handler) Duplicate(w http.ResponseWriter, r *http.Request) {
	plannerID, ok := plannerIDFromPath(r)
	if !ok {
		jsonError(w, http.StatusBadRequest, "Invalid planner ID")
		return
	}
	userID := middleware.UserFrom(r).ID

	var body struct {
		TitleSuffix  *string `json:"titleSuffix"`
		OffsetYears  *int    `json:"offsetYears"`
		OffsetMonths *int    `json:"offsetMonths"`
		OffsetDays   *int    `json:"offsetDays"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		// Empty body is fine — all fields are optional.
		if !errors.Is(err, io.EOF) {
			jsonError(w, http.StatusBadRequest, "Invalid JSON")
			return
		}
	}

	// Resolve defaults.
	titleSuffix := " (copy)"
	if body.TitleSuffix != nil {
		titleSuffix = *body.TitleSuffix
	}
	offsetYears := 0
	if body.OffsetYears != nil {
		offsetYears = *body.OffsetYears
	}
	offsetMonths := 0
	if body.OffsetMonths != nil {
		offsetMonths = *body.OffsetMonths
	}
	offsetDays := 0
	if body.OffsetDays != nil {
		offsetDays = *body.OffsetDays
	}

	// If no offset is specified at all, default to +1 year.
	if body.OffsetYears == nil && body.OffsetMonths == nil && body.OffsetDays == nil {
		offsetYears = 1
	}

	// Validation: zero offset AND no explicit titleSuffix is a confusing exact-duplicate.
	// (If they explicitly passed titleSuffix we allow zero offset — different title is enough.)
	if offsetYears == 0 && offsetMonths == 0 && offsetDays == 0 && body.TitleSuffix == nil {
		jsonError(w, http.StatusBadRequest, "specify at least one of offsetYears, offsetMonths, offsetDays, or a custom titleSuffix")
		return
	}

	// 1. Verify user has view access (before opening the transaction to avoid
	//    SQLite write-lock contention when CanAccess reads from the same pool).
	if _, err := middleware.CanAccess(r.Context(), h.db, plannerID, userID, "view"); err != nil {
		handleAccessErr(w, err)
		return
	}

	tx, err := h.db.BeginTx(r.Context(), nil)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	defer tx.Rollback()

	// 2. SELECT source planner: title, start_date, end_date.
	var srcTitle string
	var srcStart, srcEnd db.DateStr
	if err := tx.QueryRowContext(r.Context(),
		h.db.Rebind("SELECT title, start_date, end_date FROM planners WHERE id = ?"),
		plannerID,
	).Scan(&srcTitle, &srcStart, &srcEnd); err != nil {
		jsonError(w, http.StatusNotFound, "Planner not found")
		return
	}

	// 3. Compute new title and shifted dates.
	newTitle := srcTitle + titleSuffix

	shiftDate := func(dateStr string) (string, error) {
		t, err := time.Parse("2006-01-02", dateStr)
		if err != nil {
			return "", err
		}
		return t.AddDate(offsetYears, offsetMonths, offsetDays).Format("2006-01-02"), nil
	}

	newStart, err := shiftDate(srcStart.String())
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	newEnd, err := shiftDate(srcEnd.String())
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	// 4. INSERT new planner row owned by current user; return new id.
	var newPlannerID int
	var newPlannerTitle string
	var newPlannerStart, newPlannerEnd db.DateStr
	if err := tx.QueryRowContext(r.Context(),
		h.db.Rebind(`INSERT INTO planners(owner_id, title, start_date, end_date)
		             VALUES (?, ?, ?, ?) RETURNING id, title, start_date, end_date`),
		userID, newTitle, newStart, newEnd,
	).Scan(&newPlannerID, &newPlannerTitle, &newPlannerStart, &newPlannerEnd); err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	// 5. SELECT lanes from source planner.
	laneRows, err := tx.QueryContext(r.Context(),
		h.db.Rebind("SELECT id, name, sort_order, color FROM lanes WHERE planner_id = ? ORDER BY sort_order"),
		plannerID,
	)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	type laneRow struct {
		id    string
		name  string
		order int
		color string
	}
	var lanes []laneRow
	for laneRows.Next() {
		var l laneRow
		if err := laneRows.Scan(&l.id, &l.name, &l.order, &l.color); err != nil {
			laneRows.Close()
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
		lanes = append(lanes, l)
	}
	laneRows.Close()

	// 6. INSERT lanes into new planner (reuse same lane ids — scoped per planner).
	// Chunk 100 lanes × 5 cols = 500 placeholders.
	const laneChunk = 100
	for start := 0; start < len(lanes); start += laneChunk {
		end := start + laneChunk
		if end > len(lanes) {
			end = len(lanes)
		}
		batch := lanes[start:end]
		ph := strings.TrimSuffix(strings.Repeat("(?,?,?,?,?),", len(batch)), ",")
		args := make([]any, 0, len(batch)*5)
		for _, l := range batch {
			args = append(args, l.id, newPlannerID, l.name, l.order, l.color)
		}
		q := h.db.Rebind("INSERT INTO lanes(id, planner_id, name, sort_order, color) VALUES " + ph)
		if _, err := tx.ExecContext(r.Context(), q, args...); err != nil {
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
	}

	// 7. SELECT activities from source planner (all columns including recurrence, status, milestone).
	actRows, err := tx.QueryContext(r.Context(),
		h.db.Rebind(`SELECT id, lane_id, title, description, start_date, end_date, color, label,
		             recurrence_type, recurrence_interval, recurrence_weekdays, recurrence_until,
		             status, is_milestone, recurrence_monthly_rule, recurrence_exceptions, recurrence_overrides
		      FROM activities WHERE planner_id = ?`),
		plannerID,
	)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	type dupActRow struct {
		id             string
		laneID         string
		title          string
		desc           string
		startDate      string
		endDate        string
		color          string
		label          string
		recType        sql.NullString
		recInterval    sql.NullInt64
		recWeekdays    sql.NullString
		recUntil       sql.NullString
		status         string
		isMilestone    int
		recMonthlyRule sql.NullString
		recExceptions  sql.NullString
		recOverrides   sql.NullString
	}
	var acts []dupActRow
	for actRows.Next() {
		var a dupActRow
		var startDate, endDate db.DateStr
		if err := actRows.Scan(&a.id, &a.laneID, &a.title, &a.desc, &startDate, &endDate,
			&a.color, &a.label, &a.recType, &a.recInterval, &a.recWeekdays, &a.recUntil,
			&a.status, &a.isMilestone, &a.recMonthlyRule, &a.recExceptions, &a.recOverrides); err != nil {
			actRows.Close()
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
		if a.status == "" {
			a.status = "planned"
		}
		// 8. Compute shifted start/end dates.
		a.startDate, err = shiftDate(startDate.String())
		if err != nil {
			actRows.Close()
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
		a.endDate, err = shiftDate(endDate.String())
		if err != nil {
			actRows.Close()
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
		// Shift recurrence_until only if non-null.
		if a.recUntil.Valid {
			shifted, err := shiftDate(a.recUntil.String)
			if err != nil {
				actRows.Close()
				jsonError(w, http.StatusInternalServerError, "Internal server error")
				return
			}
			a.recUntil = sql.NullString{String: shifted, Valid: true}
		}
		// Note: recurrence_exceptions and recurrence_overrides are date-keyed; we intentionally
		// do NOT shift them because they refer to specific occurrences that may not apply after
		// date shifting. Clear both in duplicated planners.
		a.recExceptions = sql.NullString{}
		a.recOverrides = sql.NullString{}
		acts = append(acts, a)
	}
	actRows.Close()

	// 9. INSERT activities with chunked multi-row INSERTs (reuse activity IDs).
	// 50 rows × 19 cols = 950 placeholders — still under SQLite's 999 limit.
	const dupActChunk = 50
	for start := 0; start < len(acts); start += dupActChunk {
		end := start + dupActChunk
		if end > len(acts) {
			end = len(acts)
		}
		batch := acts[start:end]
		ph := strings.TrimSuffix(strings.Repeat("(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?),", len(batch)), ",")
		args := make([]any, 0, len(batch)*19)
		for _, a := range batch {
			args = append(args, a.id, a.laneID, newPlannerID, a.title, a.desc,
				a.startDate, a.endDate, a.color, a.label,
				a.recType, a.recInterval, a.recWeekdays, a.recUntil, userID,
				a.status, a.isMilestone, a.recMonthlyRule, a.recExceptions, a.recOverrides)
		}
		q := h.db.Rebind(`INSERT INTO activities(id, lane_id, planner_id, title, description, start_date, end_date, color, label,
		                  recurrence_type, recurrence_interval, recurrence_weekdays, recurrence_until, created_by,
		                  status, is_milestone, recurrence_monthly_rule, recurrence_exceptions, recurrence_overrides) VALUES ` + ph)
		if _, err := tx.ExecContext(r.Context(), q, args...); err != nil {
			jsonError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
	}

	// Note: activity_user_tags are intentionally not copied — different planner audience.

	if err := tx.Commit(); err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":        newPlannerID,
		"title":     newPlannerTitle,
		"startDate": newPlannerStart.String(),
		"endDate":   newPlannerEnd.String(),
	})
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

// formatMonthlyRuleDOM serializes a day-of-month rule: "dom:15".
func formatMonthlyRuleDOM(day int) string {
	return "dom:" + strconv.Itoa(day)
}

// formatMonthlyRuleNthWd serializes a nth-weekday rule: "nthwd:2,3".
func formatMonthlyRuleNthWd(week, weekday int) string {
	return "nthwd:" + strconv.Itoa(week) + "," + strconv.Itoa(weekday)
}

// parseMonthlyRule parses stored text back into a map for JSON output.
// Returns nil if the string is malformed.
func parseMonthlyRule(s string) map[string]any {
	if strings.HasPrefix(s, "dom:") {
		dayStr := strings.TrimPrefix(s, "dom:")
		day, err := strconv.Atoi(dayStr)
		if err != nil {
			return nil
		}
		return map[string]any{"kind": "dom", "day": day}
	}
	if strings.HasPrefix(s, "nthwd:") {
		rest := strings.TrimPrefix(s, "nthwd:")
		parts := strings.SplitN(rest, ",", 2)
		if len(parts) != 2 {
			return nil
		}
		week, err1 := strconv.Atoi(parts[0])
		weekday, err2 := strconv.Atoi(parts[1])
		if err1 != nil || err2 != nil {
			return nil
		}
		return map[string]any{"kind": "nthwd", "week": week, "weekday": weekday}
	}
	return nil
}

// isValidDate returns true if s matches YYYY-MM-DD (basic length + digit check).
func isValidDate(s string) bool {
	if len(s) != 10 {
		return false
	}
	// Quick structural check: expect digits at positions 0-3, 5-6, 8-9 and dashes at 4, 7.
	if s[4] != '-' || s[7] != '-' {
		return false
	}
	for _, i := range []int{0, 1, 2, 3, 5, 6, 8, 9} {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}
