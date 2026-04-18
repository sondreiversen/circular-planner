// Package importing implements calendar-import routes. Named "importing"
// because "import" is a reserved Go keyword.
package importing

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"planner/internal/config"
	"planner/internal/db"
	"planner/internal/ews"
	"planner/internal/middleware"
)

type Handler struct {
	db  *db.DB
	cfg *config.Config
}

func NewHandler(database *db.DB, cfg *config.Config) *Handler {
	return &Handler{db: database, cfg: cfg}
}

var dateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

type importRequest struct {
	ServerURL           string `json:"serverUrl"`
	Username            string `json:"username"`
	Password            string `json:"password"`
	AuthMethod          string `json:"authMethod"`
	StartDate           string `json:"startDate"`
	EndDate             string `json:"endDate"`
	AllowSelfSignedCert bool   `json:"allowSelfSignedCert"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func jsonError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// ImportOutlook handles POST /api/planners/{id}/import/outlook.
// Returns events for preview — does not persist. Client calls PUT /api/planners/{id}
// afterwards with the user's selected subset.
func (h *Handler) ImportOutlook(w http.ResponseWriter, r *http.Request) {
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

	var body importRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}

	if body.ServerURL == "" {
		jsonError(w, http.StatusBadRequest, "serverUrl is required")
		return
	}
	if body.Username == "" {
		jsonError(w, http.StatusBadRequest, "username is required")
		return
	}
	if body.Password == "" {
		jsonError(w, http.StatusBadRequest, "password is required")
		return
	}
	if !dateRe.MatchString(body.StartDate) {
		jsonError(w, http.StatusBadRequest, "startDate must be YYYY-MM-DD")
		return
	}
	if !dateRe.MatchString(body.EndDate) {
		jsonError(w, http.StatusBadRequest, "endDate must be YYYY-MM-DD")
		return
	}

	// SSRF protection: require HTTPS and /ews/ path segment.
	u, perr := url.Parse(body.ServerURL)
	if perr != nil {
		jsonError(w, http.StatusBadRequest, "Invalid serverUrl")
		return
	}
	if u.Scheme != "https" {
		jsonError(w, http.StatusBadRequest, "serverUrl must use HTTPS")
		return
	}
	if !strings.Contains(u.Path, "/ews/") {
		jsonError(w, http.StatusBadRequest, "serverUrl must contain /ews/ path")
		return
	}

	method := "ntlm"
	if strings.EqualFold(body.AuthMethod, "basic") {
		method = "basic"
	}

	result, err := ews.FetchCalendarEvents(context.Background(), ews.Config{
		ServerURL:           body.ServerURL,
		Username:            body.Username,
		Password:            body.Password,
		AuthMethod:          method,
		AllowSelfSignedCert: body.AllowSelfSignedCert,
	}, ews.Query{StartDate: body.StartDate, EndDate: body.EndDate})
	if err != nil {
		classifyError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// classifyError maps known error substrings to HTTP statuses, matching the
// Node backend's behaviour.
func classifyError(w http.ResponseWriter, err error) {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "authentication failed"):
		jsonError(w, http.StatusUnauthorized, msg)
	case strings.Contains(msg, "timed out"):
		jsonError(w, http.StatusGatewayTimeout, msg)
	case strings.Contains(msg, "no such host"),
		strings.Contains(msg, "connection refused"),
		strings.Contains(msg, "certificate"):
		jsonError(w, http.StatusBadGateway, "Cannot reach Exchange server: "+msg)
	case strings.Contains(msg, "Exchange returned an error"):
		jsonError(w, http.StatusUnprocessableEntity, msg)
	default:
		jsonError(w, http.StatusInternalServerError, msg)
	}
}

func handleAccessErr(w http.ResponseWriter, err error) {
	var ae *middleware.AccessError
	if errors.As(err, &ae) {
		jsonError(w, ae.Status, ae.Message)
		return
	}
	jsonError(w, http.StatusInternalServerError, "Internal server error")
}
