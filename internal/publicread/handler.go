// Package publicread implements the unauthenticated public planner read endpoint.
// GET /api/public/planners/{token} — no auth required.
// The token must exist in share_tokens and not be revoked.
// Response mirrors GET /api/planners/{id} but:
//   - permission is always "view", isOwner is always false.
//   - No planner_shares or group_shares included.
//   - No user emails are ever included.
//   - taggedUsers only contains id, username, fullName (no email).
package publicread

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"

	"planner/internal/db"
)

// Handler handles public (unauthenticated) planner read routes.
type Handler struct {
	db *db.DB
}

// NewHandler creates a new public read handler.
func NewHandler(database *db.DB) *Handler {
	return &Handler{db: database}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func jsonError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// GetPublic handles GET /api/public/planners/{token}.
// No auth required — the token itself grants read access.
func (h *Handler) GetPublic(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	if token == "" {
		// Return 404 to not reveal anything about the endpoint structure.
		jsonError(w, http.StatusNotFound, "Planner not found")
		return
	}

	// Resolve token → planner_id. Token must exist and not be revoked.
	var plannerID int
	err := h.db.QueryRowContext(r.Context(),
		h.db.Rebind("SELECT planner_id FROM share_tokens WHERE token = ? AND revoked_at IS NULL"),
		token,
	).Scan(&plannerID)
	if err != nil {
		// sql.ErrNoRows or any DB error → 404 (don't leak existence)
		jsonError(w, http.StatusNotFound, "Planner not found")
		return
	}

	// Fetch planner metadata.
	var title string
	var startDate, endDate db.DateStr
	var updatedAt string
	var isPublic int
	err = h.db.QueryRowContext(r.Context(),
		h.db.Rebind("SELECT title, start_date, end_date, updated_at, is_public FROM planners WHERE id = ?"),
		plannerID,
	).Scan(&title, &startDate, &endDate, &updatedAt, &isPublic)
	if err != nil {
		jsonError(w, http.StatusNotFound, "Planner not found")
		return
	}

	// Fetch lanes.
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
	laneRows.Close()

	// Fetch activities (left join creator name, no email).
	actRows, err := h.db.QueryContext(r.Context(),
		h.db.Rebind(`SELECT a.id, a.lane_id, a.title, a.description, a.start_date, a.end_date,
		             a.color, a.label, a.recurrence_type, a.recurrence_interval, a.recurrence_weekdays, a.recurrence_until,
		             COALESCE(NULLIF(u.full_name, ''), u.username) AS created_by_name,
		             a.status, a.is_milestone,
		             a.recurrence_monthly_rule, a.recurrence_exceptions
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

	activityByID := map[string]map[string]any{}
	for actRows.Next() {
		var id, laneID, title2, description, color, label string
		var startDate2, endDate2 db.DateStr
		var recType sql.NullString
		var recInterval sql.NullInt64
		var recWeekdays sql.NullString
		var recUntil sql.NullString
		var createdByName sql.NullString
		var status string
		var isMilestone int
		var recMonthlyRule sql.NullString
		var recExceptions sql.NullString
		if err := actRows.Scan(&id, &laneID, &title2, &description, &startDate2, &endDate2, &color, &label,
			&recType, &recInterval, &recWeekdays, &recUntil, &createdByName, &status, &isMilestone,
			&recMonthlyRule, &recExceptions); err != nil {
			continue
		}
		if status == "" {
			status = "planned"
		}
		act := map[string]any{
			"id":          id,
			"laneId":      laneID,
			"title":       title2,
			"description": description,
			"startDate":   startDate2.String(),
			"endDate":     endDate2.String(),
			"color":       color,
			"label":       label,
			"status":      status,
		}
		if isMilestone != 0 {
			act["isMilestone"] = true
		}
		// Include creator display name (no email).
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
				if err2 := json.Unmarshal([]byte(recExceptions.String), &excs); err2 == nil && len(excs) > 0 {
					rec["exceptions"] = excs
				}
			}
			act["recurrence"] = rec
		}
		activityByID[id] = act
		if l, ok := laneMap[laneID]; ok {
			l.Activities = append(l.Activities, act)
		}
	}
	actRows.Close()

	// Fetch tagged users — only id, username, fullName. NO email.
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

	tagsByActivity := map[string][]map[string]any{}
	for tagRows.Next() {
		var activityID, username, fullName string
		var uid int
		if err := tagRows.Scan(&activityID, &uid, &username, &fullName); err != nil {
			continue
		}
		// Defensively: only include id, username, fullName — never email.
		entry := map[string]any{
			"id":       uid,
			"username": username,
		}
		if fullName != "" {
			entry["fullName"] = fullName
		}
		tagsByActivity[activityID] = append(tagsByActivity[activityID], entry)
	}
	tagRows.Close()

	// Fetch pending tags — expose only username and pending:true (no user_id).
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

	// Always return permission=view, isOwner=false.
	writeJSON(w, http.StatusOK, map[string]any{
		"config": map[string]any{
			"plannerId":  plannerID,
			"title":      title,
			"startDate":  startDate.String(),
			"endDate":    endDate.String(),
			"isOwner":    false,
			"permission": "view",
			"updated_at": updatedAt,
			"isPublic":   isPublic == 1,
		},
		"data": map[string]any{"lanes": lanesJSON},
	})
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
		n := 0
		for _, c := range p {
			if c < '0' || c > '9' {
				goto next
			}
			n = n*10 + int(c-'0')
		}
		result = append(result, n)
	next:
	}
	return result
}

// parseMonthlyRule parses stored text back into a map for JSON output.
func parseMonthlyRule(s string) map[string]any {
	if strings.HasPrefix(s, "dom:") {
		dayStr := strings.TrimPrefix(s, "dom:")
		day := 0
		for _, c := range dayStr {
			if c < '0' || c > '9' {
				return nil
			}
			day = day*10 + int(c-'0')
		}
		return map[string]any{"kind": "dom", "day": day}
	}
	if strings.HasPrefix(s, "nthwd:") {
		rest := strings.TrimPrefix(s, "nthwd:")
		idx := strings.Index(rest, ",")
		if idx < 0 {
			return nil
		}
		weekStr := rest[:idx]
		wdStr := rest[idx+1:]
		week := 0
		neg := false
		for i, c := range weekStr {
			if i == 0 && c == '-' {
				neg = true
				continue
			}
			if c < '0' || c > '9' {
				return nil
			}
			week = week*10 + int(c-'0')
		}
		if neg {
			week = -week
		}
		weekday := 0
		for _, c := range wdStr {
			if c < '0' || c > '9' {
				return nil
			}
			weekday = weekday*10 + int(c-'0')
		}
		return map[string]any{"kind": "nthwd", "week": week, "weekday": weekday}
	}
	return nil
}
