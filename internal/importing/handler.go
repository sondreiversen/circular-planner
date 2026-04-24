// Package importing implements calendar-import routes. Named "importing"
// because "import" is a reserved Go keyword.
package importing

import (
	"crypto/rand"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	ical "github.com/arran4/golang-ical"
	"planner/internal/config"
	"planner/internal/db"
	"planner/internal/middleware"
)

const maxUploadSize = 5 << 20 // 5 MB

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
	var ae *middleware.AccessError
	if errors.As(err, &ae) {
		jsonError(w, ae.Status, ae.Message)
		return
	}
	jsonError(w, http.StatusInternalServerError, "Internal server error")
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// importedActivity is a calendar event mapped to a planner activity.
type importedActivity struct {
	ID        string
	LaneID    string
	Title     string
	Desc      string
	StartDate string // YYYY-MM-DD
	EndDate   string // YYYY-MM-DD
	Color     string
	Label     string
}

// defaultColors cycles through a small palette for imported events.
var defaultColors = []string{
	"#4c8bf5", "#0052cc", "#36b37e", "#ff7452", "#ff991f",
	"#6554c0", "#00b8d9", "#ff5630", "#57d9a3", "#ffc400",
}

// normaliseDate tries to parse various date formats and return YYYY-MM-DD.
func normaliseDate(s string) (string, bool) {
	s = strings.TrimSpace(s)
	formats := []string{
		"2006-01-02",
		"1/2/2006",
		"01/02/2006",
		"1/2/06",
		"2006/01/02",
	}
	for _, f := range formats {
		if t, err := time.Parse(f, s); err == nil {
			return t.Format("2006-01-02"), true
		}
	}
	return "", false
}

// --- POST /api/planners/{id}/import ---

func (h *Handler) Import(w http.ResponseWriter, r *http.Request) {
	plannerID, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid planner ID")
		return
	}

	userID := middleware.UserFrom(r).ID
	if _, err := middleware.CanAccess(r.Context(), h.db, plannerID, userID, "edit"); err != nil {
		handleAccessErr(w, err)
		return
	}

	if err := r.ParseMultipartForm(maxUploadSize); err != nil {
		jsonError(w, http.StatusBadRequest, "File too large or invalid multipart form (max 5 MB)")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		jsonError(w, http.StatusBadRequest, "No file uploaded (field name: 'file')")
		return
	}
	defer file.Close()

	laneID := strings.TrimSpace(r.FormValue("laneId"))

	// If no laneId provided, create a default "Imported" lane.
	if laneID == "" {
		laneID = newID()
		// Determine the next sort_order for this planner.
		var maxOrder int
		_ = h.db.QueryRowContext(r.Context(),
			h.db.Rebind("SELECT COALESCE(MAX(sort_order), -1) FROM lanes WHERE planner_id = ?"),
			plannerID,
		).Scan(&maxOrder)

		if _, dbErr := h.db.ExecContext(r.Context(), h.db.Rebind(`
			INSERT INTO lanes(id, planner_id, name, sort_order, color)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(id, planner_id) DO NOTHING
		`), laneID, plannerID, "Imported", maxOrder+1, "#4c8bf5"); dbErr != nil {
			jsonError(w, http.StatusInternalServerError, "Could not create import lane")
			return
		}
	}

	// Detect format by file extension.
	name := strings.ToLower(header.Filename)
	var activities []importedActivity

	switch {
	case strings.HasSuffix(name, ".ics"):
		activities, err = parseICS(file, laneID)
	case strings.HasSuffix(name, ".csv"):
		activities, err = parseCSV(file, laneID)
	default:
		jsonError(w, http.StatusBadRequest, "Unsupported file type. Upload a .ics or .csv file.")
		return
	}

	if err != nil {
		jsonError(w, http.StatusUnprocessableEntity, "Could not parse file: "+err.Error())
		return
	}

	if len(activities) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{
			"imported": 0,
			"message":  "No calendar events found in the file.",
		})
		return
	}

	// Insert activities into the database.
	tx, err := h.db.BeginTx(r.Context(), nil)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	defer tx.Rollback()

	stmt := h.db.Rebind(`
		INSERT INTO activities(id, lane_id, planner_id, title, description, start_date, end_date, color, label)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id, planner_id) DO NOTHING
	`)
	for _, a := range activities {
		if _, execErr := tx.ExecContext(r.Context(), stmt,
			a.ID, a.LaneID, plannerID, a.Title, a.Desc, a.StartDate, a.EndDate, a.Color, a.Label,
		); execErr != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to save activities")
			return
		}
	}

	// Update planner's updated_at timestamp.
	_, _ = tx.ExecContext(r.Context(),
		h.db.Rebind("UPDATE planners SET updated_at = ? WHERE id = ?"),
		time.Now().UTC().Format(time.RFC3339), plannerID,
	)

	if err := tx.Commit(); err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"imported": len(activities),
		"laneId":   laneID,
	})
}

// --- ICS parsing ---

func parseICS(r io.Reader, laneID string) ([]importedActivity, error) {
	cal, err := ical.ParseCalendar(r)
	if err != nil {
		return nil, err
	}

	var out []importedActivity
	colorIdx := 0

	for _, event := range cal.Events() {
		summary := ""
		if p := event.GetProperty(ical.ComponentPropertySummary); p != nil {
			summary = strings.TrimSpace(p.Value)
		}
		if summary == "" {
			summary = "(no title)"
		}

		desc := ""
		if p := event.GetProperty(ical.ComponentPropertyDescription); p != nil {
			desc = strings.TrimSpace(p.Value)
		}

		startDate, endDate := "", ""

		// Try typed DTSTART/DTEND
		if dtstart, e := event.GetStartAt(); e == nil {
			startDate = dtstart.Format("2006-01-02")
		} else if p := event.GetProperty(ical.ComponentPropertyDtStart); p != nil {
			if d, ok := normaliseDate(p.Value); ok {
				startDate = d
			}
		}

		if dtend, e := event.GetEndAt(); e == nil {
			endDate = dtend.Format("2006-01-02")
		} else if p := event.GetProperty(ical.ComponentPropertyDtEnd); p != nil {
			if d, ok := normaliseDate(p.Value); ok {
				endDate = d
			}
		}

		if startDate == "" {
			continue // skip events with no date
		}
		if endDate == "" || endDate < startDate {
			endDate = startDate
		}
		// iCal DTEND for all-day events is exclusive (next day); subtract 1 day.
		if endDate > startDate {
			t, pErr := time.Parse("2006-01-02", endDate)
			if pErr == nil {
				// Only subtract if it looks like an all-day event (no time component)
				if dtstart, e := event.GetStartAt(); e == nil {
					h2, m, s := dtstart.Clock()
					if h2 == 0 && m == 0 && s == 0 {
						endDate = t.AddDate(0, 0, -1).Format("2006-01-02")
						if endDate < startDate {
							endDate = startDate
						}
					}
				}
			}
		}

		categories := ""
		if p := event.GetProperty(ical.ComponentPropertyCategories); p != nil {
			cats := strings.Split(p.Value, ",")
			if len(cats) > 0 {
				categories = strings.TrimSpace(cats[0])
			}
		}

		out = append(out, importedActivity{
			ID:        newID(),
			LaneID:    laneID,
			Title:     summary,
			Desc:      desc,
			StartDate: startDate,
			EndDate:   endDate,
			Color:     defaultColors[colorIdx%len(defaultColors)],
			Label:     categories,
		})
		colorIdx++
	}

	return out, nil
}

// --- CSV parsing (Outlook export format) ---

// Outlook CSV columns we care about (case-insensitive header match).
const (
	colSubject   = "subject"
	colStartDate = "start date"
	colEndDate   = "end date"
	colDesc      = "description"
	colCategories = "categories"
)

func parseCSV(r io.Reader, laneID string) ([]importedActivity, error) {
	reader := csv.NewReader(r)
	reader.LazyQuotes = true
	reader.TrimLeadingSpace = true

	records, err := reader.ReadAll()
	if err != nil {
		return nil, err
	}
	if len(records) < 2 {
		return nil, nil // empty file
	}

	// Map header names (lowercased) to column indices.
	headers := make(map[string]int)
	for i, h := range records[0] {
		headers[strings.ToLower(strings.TrimSpace(h))] = i
	}

	colIdx := func(name string) int {
		idx, ok := headers[name]
		if !ok {
			return -1
		}
		return idx
	}

	get := func(row []string, idx int) string {
		if idx < 0 || idx >= len(row) {
			return ""
		}
		return strings.TrimSpace(row[idx])
	}

	iSubject := colIdx(colSubject)
	iStart := colIdx(colStartDate)
	iEnd := colIdx(colEndDate)
	iDesc := colIdx(colDesc)
	iCats := colIdx(colCategories)

	var out []importedActivity
	colorIdx := 0

	for _, row := range records[1:] {
		title := get(row, iSubject)
		if title == "" {
			title = "(no title)"
		}

		startDate, ok := normaliseDate(get(row, iStart))
		if !ok {
			continue // skip rows without a valid date
		}

		endDate, ok2 := normaliseDate(get(row, iEnd))
		if !ok2 || endDate < startDate {
			endDate = startDate
		}

		desc := get(row, iDesc)
		label := ""
		if iCats >= 0 {
			cats := strings.Split(get(row, iCats), ";")
			if len(cats) > 0 {
				label = strings.TrimSpace(cats[0])
			}
		}

		out = append(out, importedActivity{
			ID:        newID(),
			LaneID:    laneID,
			Title:     title,
			Desc:      desc,
			StartDate: startDate,
			EndDate:   endDate,
			Color:     defaultColors[colorIdx%len(defaultColors)],
			Label:     label,
		})
		colorIdx++
	}

	return out, nil
}
