// Package testutil builds an in-memory test server backed by a temp-dir SQLite DB.
package testutil

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"planner/internal/auth"
	"planner/internal/config"
	"planner/internal/db"
	"planner/internal/middleware"
	"planner/internal/planners"
	"planner/internal/share"
)

// NewServer returns a started *httptest.Server wired up with all API routes
// against a fresh SQLite database in t.TempDir(). It also returns the config
// (holding the JWT secret used to mint tokens) and the DB for direct setup.
func NewServer(t *testing.T) (*httptest.Server, *config.Config, *db.DB) {
	t.Helper()

	dbPath := filepath.Join(t.TempDir(), "test.db")
	database, err := db.Open("sqlite:" + dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		database.Close()
		t.Fatalf("db.Migrate: %v", err)
	}

	cfg := &config.Config{
		JWTSecret:     "test-secret-at-least-32-characters-long-x",
		AllowedOrigin: "http://localhost:3000",
	}

	mux := http.NewServeMux()
	authH := auth.NewHandler(database, cfg)
	mux.HandleFunc("POST /api/auth/register", authH.Register)
	mux.HandleFunc("POST /api/auth/login", authH.Login)
	mux.HandleFunc("GET /api/auth/me", middleware.RequireAuth(cfg, authH.Me))

	planH := planners.NewHandler(database, cfg)
	mux.HandleFunc("GET /api/planners", middleware.RequireAuth(cfg, planH.List))
	mux.HandleFunc("POST /api/planners", middleware.RequireAuth(cfg, planH.Create))
	mux.HandleFunc("GET /api/planners/{id}", middleware.RequireAuth(cfg, planH.Get))
	mux.HandleFunc("PUT /api/planners/{id}", middleware.RequireAuth(cfg, planH.Update))
	mux.HandleFunc("DELETE /api/planners/{id}", middleware.RequireAuth(cfg, planH.Delete))

	shareH := share.NewHandler(database, cfg)
	mux.HandleFunc("GET /api/planners/{plannerID}/shares", middleware.RequireAuth(cfg, shareH.List))
	mux.HandleFunc("POST /api/planners/{plannerID}/shares", middleware.RequireAuth(cfg, shareH.Create))
	mux.HandleFunc("DELETE /api/planners/{plannerID}/shares/{userID}", middleware.RequireAuth(cfg, shareH.Delete))

	srv := httptest.NewServer(mux)
	t.Cleanup(func() {
		srv.Close()
		database.Close()
	})
	return srv, cfg, database
}
