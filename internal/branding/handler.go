// Package branding implements the GET /api/branding endpoint.
package branding

import (
	"encoding/json"
	"net/http"

	"planner/internal/config"
)

// Handler handles branding routes.
type Handler struct {
	cfg *config.Config
}

func NewHandler(cfg *config.Config) *Handler {
	return &Handler{cfg: cfg}
}

// Register mounts the branding route on mux. No authentication required.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/branding", h.Branding)
}

// GET /api/branding — returns app name and optional logo URL.
func (h *Handler) Branding(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"name":    h.cfg.AppName,
		"logoUrl": h.cfg.AppLogoURL,
	})
}
