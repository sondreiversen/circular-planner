// Package testutil builds an in-memory test server backed by a temp-dir SQLite DB.
package testutil

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"planner/internal/admin"
	"planner/internal/auth"
	"planner/internal/config"
	"planner/internal/db"
	"planner/internal/groups"
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
		JWTSecret:         "test-secret-at-least-32-characters-long-x",
		AllowedOrigin:     "http://localhost:3000",
		AllowRegistration: true,
	}

	mux := http.NewServeMux()
	authH := auth.NewHandler(database, cfg)
	mux.HandleFunc("POST /api/auth/register", authH.Register)
	mux.HandleFunc("POST /api/auth/login", authH.Login)
	mux.HandleFunc("GET /api/auth/me", middleware.RequireAuth(cfg, database, authH.Me))
	mux.HandleFunc("GET /api/users", middleware.RequireAuth(cfg, database, authH.SearchUsers))

	planH := planners.NewHandler(database, cfg)
	mux.HandleFunc("GET /api/planners", middleware.RequireAuth(cfg, database, planH.List))
	mux.HandleFunc("POST /api/planners", middleware.RequireAuth(cfg, database, planH.Create))
	mux.HandleFunc("GET /api/planners/{id}", middleware.RequireAuth(cfg, database, planH.Get))
	mux.HandleFunc("PUT /api/planners/{id}", middleware.RequireAuth(cfg, database, planH.Update))
	mux.HandleFunc("DELETE /api/planners/{id}", middleware.RequireAuth(cfg, database, planH.Delete))

	shareH := share.NewHandler(database, cfg)
	mux.HandleFunc("GET /api/planners/{plannerID}/shares", middleware.RequireAuth(cfg, database, shareH.List))
	mux.HandleFunc("POST /api/planners/{plannerID}/shares", middleware.RequireAuth(cfg, database, shareH.Create))
	mux.HandleFunc("DELETE /api/planners/{plannerID}/shares/{userID}", middleware.RequireAuth(cfg, database, shareH.Delete))

	groupH := groups.NewHandler(database, cfg)
	groupH.Register(mux, cfg, database)

	adminH := admin.NewHandler(database)
	mux.HandleFunc("GET /api/admin/users", middleware.RequireAdmin(cfg, database, adminH.ListUsers))
	mux.HandleFunc("PATCH /api/admin/users/{id}", middleware.RequireAdmin(cfg, database, adminH.UpdateUser))
	mux.HandleFunc("DELETE /api/admin/users/{id}", middleware.RequireAdmin(cfg, database, adminH.DeleteUser))

	srv := httptest.NewServer(mux)
	t.Cleanup(func() {
		srv.Close()
		database.Close()
	})
	return srv, cfg, database
}
