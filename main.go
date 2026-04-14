// Command planner is the Go backend for the Circular Planner web application.
//
// Build: go build -o planner .        (embeds public/ into the binary)
// Run:   ./planner                     (SQLite at ./data/planner.db by default)
//        DATABASE_URL=postgres://...  ./planner  (use Postgres instead)
//
// The static frontend must be built before go build:
//   npm run build:client
package main

import (
	"context"
	"crypto/tls"
	"embed"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"planner/internal/auth"
	"planner/internal/config"
	"planner/internal/db"
	"planner/internal/middleware"
	"planner/internal/planners"
	"planner/internal/share"
)

// publicFS embeds the entire public/ directory (HTML, CSS, compiled JS).
// Run `npm run build:client` before `go build .` so JS bundles are present.
//
//go:embed public
var publicFS embed.FS

func main() {
	loadDotEnv()

	cfg := config.Load()

	if cfg.DataDir != "" {
		if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
			log.Fatalf("create data dir: %v", err)
		}
	}

	database, err := db.Open(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("db.Open: %v", err)
	}
	defer database.Close()

	if err := db.Migrate(database); err != nil {
		log.Fatalf("migration: %v", err)
	}

	mux := http.NewServeMux()

	// Auth routes
	authH := auth.NewHandler(database, cfg)
	mux.HandleFunc("POST /api/auth/register", authH.Register)
	mux.HandleFunc("POST /api/auth/login", authH.Login)
	mux.HandleFunc("GET /api/auth/me", middleware.RequireAuth(cfg, authH.Me))
	mux.HandleFunc("GET /api/auth/gitlab/status", authH.GitLabStatus)
	mux.HandleFunc("GET /api/auth/gitlab/authorize", authH.GitLabAuthorize)
	mux.HandleFunc("GET /api/auth/gitlab/callback", authH.GitLabCallback)

	// Planner CRUD routes
	planH := planners.NewHandler(database, cfg)
	mux.HandleFunc("GET /api/planners", middleware.RequireAuth(cfg, planH.List))
	mux.HandleFunc("POST /api/planners", middleware.RequireAuth(cfg, planH.Create))
	mux.HandleFunc("GET /api/planners/{id}", middleware.RequireAuth(cfg, planH.Get))
	mux.HandleFunc("PUT /api/planners/{id}", middleware.RequireAuth(cfg, planH.Update))
	mux.HandleFunc("DELETE /api/planners/{id}", middleware.RequireAuth(cfg, planH.Delete))

	// Share management routes
	shareH := share.NewHandler(database, cfg)
	mux.HandleFunc("GET /api/planners/{plannerID}/shares", middleware.RequireAuth(cfg, shareH.List))
	mux.HandleFunc("POST /api/planners/{plannerID}/shares", middleware.RequireAuth(cfg, shareH.Create))
	mux.HandleFunc("DELETE /api/planners/{plannerID}/shares/{userID}", middleware.RequireAuth(cfg, shareH.Delete))

	// Static files embedded from public/ (HTML, CSS, JS bundles)
	sub, err := fs.Sub(publicFS, "public")
	if err != nil {
		log.Fatalf("embed.Sub: %v", err)
	}
	mux.Handle("/", spaHandler(http.FileServer(http.FS(sub))))

	startServers(cfg, securityHeaders(cfg.AllowedOrigin)(mux))
}

// startServers starts HTTP (and optionally HTTPS) listeners and blocks until
// SIGINT/SIGTERM, then gracefully shuts down.
func startServers(cfg *config.Config, handler http.Handler) {
	isTLS := cfg.TLSCertFile != "" && cfg.TLSKeyFile != ""
	var servers []*http.Server

	if isTLS {
		httpsAddr := ":" + strconv.Itoa(cfg.HTTPSPort)
		httpsServer := &http.Server{
			Addr:              httpsAddr,
			Handler:           handler,
			TLSConfig:         &tls.Config{MinVersion: tls.VersionTLS12},
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       30 * time.Second,
			WriteTimeout:      60 * time.Second,
			IdleTimeout:       120 * time.Second,
		}
		servers = append(servers, httpsServer)
		go func() {
			log.Printf("Circular Planner running at https://localhost:%d", cfg.HTTPSPort)
			if err := httpsServer.ListenAndServeTLS(cfg.TLSCertFile, cfg.TLSKeyFile); err != nil && err != http.ErrServerClosed {
				log.Printf("HTTPS server error: %v", err)
			}
		}()

		var httpH http.Handler
		if cfg.ForceHTTPS {
			httpsPort := cfg.HTTPSPort
			httpH = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				host := stripPort(r.Host)
				http.Redirect(w, r, "https://"+host+":"+strconv.Itoa(httpsPort)+r.RequestURI, http.StatusMovedPermanently)
			})
		} else {
			httpH = handler
		}
		httpServer := &http.Server{
			Addr:              ":" + strconv.Itoa(cfg.Port),
			Handler:           httpH,
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       30 * time.Second,
			WriteTimeout:      60 * time.Second,
			IdleTimeout:       120 * time.Second,
		}
		servers = append(servers, httpServer)
		suffix := ""
		if cfg.ForceHTTPS {
			suffix = " (→ HTTPS redirect)"
		}
		go func() {
			log.Printf("HTTP listener on port %d%s", cfg.Port, suffix)
			if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Printf("HTTP server error: %v", err)
			}
		}()
	} else {
		log.Println("[WARNING] TLS_CERT_FILE / TLS_KEY_FILE not set — serving over HTTP only.")
		srv := &http.Server{
			Addr:              ":" + strconv.Itoa(cfg.Port),
			Handler:           handler,
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       30 * time.Second,
			WriteTimeout:      60 * time.Second,
			IdleTimeout:       120 * time.Second,
		}
		servers = append(servers, srv)
		go func() {
			log.Printf("Circular Planner running at http://localhost:%d", cfg.Port)
			if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Printf("Server error: %v", err)
			}
		}()
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Println("Shutting down…")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, srv := range servers {
		_ = srv.Shutdown(ctx)
	}
}

// spaHandler serves static files; any path that would 404 falls back to index.html.
func spaHandler(fileServer http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rw := &responseRecorder{ResponseWriter: w}
		fileServer.ServeHTTP(rw, r)
		if rw.status == http.StatusNotFound {
			for k := range w.Header() {
				delete(w.Header(), k)
			}
			http.ServeFileFS(w, r, publicFS, "public/index.html")
		}
	})
}

type responseRecorder struct {
	http.ResponseWriter
	status int
}

func (rr *responseRecorder) WriteHeader(status int) {
	rr.status = status
	if status != http.StatusNotFound {
		rr.ResponseWriter.WriteHeader(status)
	}
}

func (rr *responseRecorder) Write(b []byte) (int, error) {
	if rr.status == http.StatusNotFound {
		return len(b), nil
	}
	return rr.ResponseWriter.Write(b)
}

func securityHeaders(allowedOrigin string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("X-Frame-Options", "DENY")
			w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
			w.Header().Set("Content-Security-Policy",
				"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:")
			// Reject cross-origin API calls from unexpected origins
			if origin := r.Header.Get("Origin"); origin != "" && origin != allowedOrigin && strings.HasPrefix(r.URL.Path, "/api/") {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func stripPort(host string) string {
	for i := len(host) - 1; i >= 0; i-- {
		if host[i] == ':' {
			return host[:i]
		}
	}
	return host
}

// loadDotEnv reads KEY=VALUE pairs from .env and sets unset env vars.
func loadDotEnv() {
	data, err := os.ReadFile(".env")
	if err != nil {
		return
	}
	for _, line := range splitLines(string(data)) {
		line = trimComment(line)
		if line == "" {
			continue
		}
		idx := -1
		for i, c := range line {
			if c == '=' {
				idx = i
				break
			}
		}
		if idx < 0 {
			continue
		}
		key, val := line[:idx], line[idx+1:]
		if len(val) >= 2 && val[0] == '"' && val[len(val)-1] == '"' {
			val = val[1 : len(val)-1]
		}
		if os.Getenv(key) == "" {
			_ = os.Setenv(key, val)
		}
	}
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i, c := range s {
		if c == '\n' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}

func trimComment(s string) string {
	for i, c := range s {
		if c == '#' {
			return s[:i]
		}
	}
	return s
}
