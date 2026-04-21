// Package health implements GET /api/health — a liveness/readiness probe.
package health

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"planner/internal/db"
)

var startTime = time.Now()

// Handler serves the health endpoint.
type Handler struct {
	db      *db.DB
	version string
}

// NewHandler creates a Handler. version is typically injected via -ldflags.
func NewHandler(database *db.DB, version string) *Handler {
	return &Handler{db: database, version: version}
}

// Register mounts GET /api/health on mux. No authentication is required.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/health", h.Health)
}

// GET /api/health — returns JSON health status.
//
// 200 OK when the database is reachable:
//
//	{"status":"ok","db":"ok","migrations":{"applied_count":4,"latest":"004-groups.sql"},"uptime_s":123,"version":"dev"}
//
// 503 when the database is down:
//
//	{"status":"degraded","db":"error: ...","migrations":null,"uptime_s":123,"version":"dev"}
func (h *Handler) Health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	dbStatus := "ok"
	var migInfo *migrationsInfo

	// Probe the database.
	var one int
	err := h.db.QueryRowContext(ctx, "SELECT 1").Scan(&one)
	if err != nil {
		dbStatus = "error: " + err.Error()
	} else {
		// Populate migration info only when DB is reachable.
		applied, listErr := db.ListApplied(h.db)
		if listErr == nil {
			info := &migrationsInfo{AppliedCount: len(applied)}
			if len(applied) > 0 {
				info.Latest = applied[len(applied)-1].Filename
			}
			migInfo = info
		}
	}

	status := "ok"
	httpStatus := http.StatusOK
	if dbStatus != "ok" {
		status = "degraded"
		httpStatus = http.StatusServiceUnavailable
	}

	resp := map[string]interface{}{
		"status":     status,
		"db":         dbStatus,
		"migrations": migInfo,
		"uptime_s":   int(time.Since(startTime).Seconds()),
		"version":    h.version,
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(httpStatus)
	_ = json.NewEncoder(w).Encode(resp)
}

type migrationsInfo struct {
	AppliedCount int    `json:"applied_count"`
	Latest       string `json:"latest,omitempty"`
}
