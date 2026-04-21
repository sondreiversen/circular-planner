// Package importing implements calendar-import routes. Named "importing"
// because "import" is a reserved Go keyword.
package importing

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

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
	h := &Handler{db: database, cfg: cfg}
	// Start background pruner — removes expired jobs every 5 minutes.
	go func() {
		for range time.Tick(5 * time.Minute) {
			h.pruneJobs()
		}
	}()
	return h
}

var dateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// ── In-memory job store ───────────────────────────────────────────────────────

type importJob struct {
	State          string          `json:"state"` // "running" | "done" | "failed"
	CompletedPages int             `json:"completed_pages"`
	TotalPages     int             `json:"total_pages"`
	LastError      string          `json:"last_error,omitempty"`
	Result         *ews.Result     `json:"result,omitempty"`
	createdAt      time.Time
}

var (
	jobs sync.Map // map[string]*importJob
)

const jobTTL = 10 * time.Minute

func (h *Handler) pruneJobs() {
	cutoff := time.Now().Add(-jobTTL)
	jobs.Range(func(key, value any) bool {
		if j, ok := value.(*importJob); ok && j.createdAt.Before(cutoff) {
			jobs.Delete(key)
		}
		return true
	})
}

func newJobID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ── helpers ───────────────────────────────────────────────────────────────────

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
// Validates the request, starts an async import job, and returns { jobId }
// immediately. The client polls GET .../import/status/:jobId for progress.
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

	jobID := newJobID()
	job := &importJob{
		State:     "running",
		createdAt: time.Now(),
	}
	jobs.Store(jobID, job)

	cfg := ews.Config{
		ServerURL:           body.ServerURL,
		Username:            body.Username,
		Password:            body.Password,
		AuthMethod:          method,
		AllowSelfSignedCert: body.AllowSelfSignedCert,
	}
	q := ews.Query{StartDate: body.StartDate, EndDate: body.EndDate}

	go func() {
		result, err := ews.FetchCalendarEvents(context.Background(), cfg, q, func(completed, total int) {
			job.CompletedPages = completed
			job.TotalPages = total
		})
		if err != nil {
			job.State = "failed"
			job.LastError = err.Error()
		} else {
			job.State = "done"
			job.Result = &result
		}
	}()

	writeJSON(w, http.StatusAccepted, map[string]string{"jobId": jobID})
}

// ImportStatus handles GET /api/planners/{id}/import/status/{jobId}.
// Returns job progress. When state is "done", result is included and the job is removed.
// When state is "failed", the job is removed and an error response is sent.
func (h *Handler) ImportStatus(w http.ResponseWriter, r *http.Request) {
	plannerID, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid planner ID")
		return
	}

	userID := middleware.UserFrom(r).ID
	if _, err := middleware.CanAccess(r.Context(), h.db, plannerID, userID, "view"); err != nil {
		handleAccessErr(w, err)
		return
	}

	jobID := r.PathValue("jobId")
	v, ok := jobs.Load(jobID)
	if !ok {
		jsonError(w, http.StatusNotFound, "Job not found or expired")
		return
	}
	job := v.(*importJob)

	switch job.State {
	case "done":
		jobs.Delete(jobID)
		writeJSON(w, http.StatusOK, map[string]any{
			"state":           "done",
			"completed_pages": job.CompletedPages,
			"total_pages":     job.TotalPages,
			"result":          job.Result,
		})
	case "failed":
		jobs.Delete(jobID)
		msg := job.LastError
		if msg == "" {
			msg = "Import failed"
		}
		jsonError(w, classifyError(msg), msg)
	default: // running
		writeJSON(w, http.StatusOK, map[string]any{
			"state":           "running",
			"completed_pages": job.CompletedPages,
			"total_pages":     job.TotalPages,
		})
	}
}

// classifyError maps known error substrings to HTTP statuses, matching the
// Node backend's behaviour.
func classifyError(msg string) int {
	switch {
	case strings.Contains(msg, "authentication failed"):
		return http.StatusUnauthorized
	case strings.Contains(msg, "timed out"):
		return http.StatusGatewayTimeout
	case strings.Contains(msg, "no such host"),
		strings.Contains(msg, "connection refused"),
		strings.Contains(msg, "certificate"):
		return http.StatusBadGateway
	case strings.Contains(msg, "Exchange returned an error"):
		return http.StatusUnprocessableEntity
	default:
		return http.StatusInternalServerError
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
