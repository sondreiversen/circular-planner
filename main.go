// Command planner is the Go backend for the Circular Planner web application.
//
// Build: go build -o planner .        (embeds public/ into the binary)
// Run:   ./planner                     (SQLite at ./data/planner.db by default)
//
//	DATABASE_URL=postgres://...  ./planner  (use Postgres instead)
//
// The static frontend must be built before go build:
//
//	npm run build:client
package main

import (
	"context"
	"crypto/tls"
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"planner/internal/admin"
	"planner/internal/auth"
	"planner/internal/branding"
	"planner/internal/clienterrors"
	"planner/internal/config"
	"planner/internal/db"
	"planner/internal/favicon"
	"planner/internal/groups"
	"planner/internal/health"
	"planner/internal/importing"
	"planner/internal/middleware"
	"planner/internal/planners"
	"planner/internal/publicread"
	"planner/internal/search"
	"planner/internal/share"
	"planner/internal/views"
)

// Version is the application version, set at build time via:
//
//	go build -ldflags "-X main.Version=1.2.3" .
var Version = "dev"

// publicFS embeds the entire public/ directory (HTML, CSS, compiled JS).
// Run `npm run build:client` before `go build .` so JS bundles are present.
//
//go:embed public
var publicFS embed.FS

// backupKeepN is the number of newest backups always retained. Count-based
// retention is what bounds a retry burst; backup.sh's age-only rule does not.
func backupKeepN() int {
	if v := os.Getenv("BACKUP_KEEP"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return n
		}
	}
	return 10
}

// backupMaxAge mirrors BACKUP_RETENTION_DAYS from scripts/backup.sh.
func backupMaxAge() time.Duration {
	days := 14
	if v := os.Getenv("BACKUP_RETENTION_DAYS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			days = n
		}
	}
	return time.Duration(days) * 24 * time.Hour
}

// backupDirFor resolves where backups live: BACKUP_DIR if set, else a
// "backups" directory beside the database.
func backupDirFor(cfg *config.Config) string {
	if d := os.Getenv("BACKUP_DIR"); d != "" {
		return d
	}
	return filepath.Join(filepath.Dir(strings.TrimPrefix(cfg.DatabaseURL, "sqlite:")), "backups")
}

// backupBeforeMigrate takes and verifies a backup immediately before applying
// migrations.
//
// It TAKES the backup rather than checking that a recent one exists. An earlier
// design gated on "a verified backup newer than the database's mtime", which is
// unsound: in WAL mode commits land in the -wal file and the main database's
// mtime does not advance until checkpoint, so a stale backup passes. It also
// fails the other way, because stopping the service checkpoints and bumps mtime
// past a backup taken moments earlier. Taking the backup makes freshness
// structural instead of inferred.
//
// Free space is checked first so the common failure is diagnosable in seconds
// rather than being a wall on a machine nobody can SSH into.
func backupBeforeMigrate(cfg *config.Config, pendingCount int) error {
	if !strings.HasPrefix(cfg.DatabaseURL, "sqlite:") {
		return fmt.Errorf("automatic backup covers SQLite only; for Postgres run scripts/backup.sh first, then re-run with --no-backup")
	}
	src := strings.TrimPrefix(cfg.DatabaseURL, "sqlite:")
	dir := backupDirFor(cfg)

	if err := checkSpaceFor(src, dir); err != nil {
		return err
	}

	log.Printf("Backing up before applying %d migration(s)...", pendingCount)
	res, err := db.BackupSQLite(src, dir, true)
	if err != nil {
		return err
	}
	log.Printf("Backup verified: %s (%d bytes, %d rows in planners)", res.Path, res.Bytes, res.RowCounts["planners"])
	if removed, err := db.PruneBackups(dir, backupKeepN(), backupMaxAge()); err == nil && len(removed) > 0 {
		log.Printf("Pruned %d old backup(s)", len(removed))
	}
	return nil
}

// checkSpaceFor fails early when the dump plainly will not fit.
//
// The dump is roughly the size of the database. Requiring 2x leaves room for
// the copy plus WAL activity, and turns "disk full halfway through a vacuum"
// into a refusal that names the number.
func checkSpaceFor(srcPath, backupDir string) error {
	fi, err := os.Stat(srcPath)
	if err != nil {
		return fmt.Errorf("stat database: %w", err)
	}
	target := backupDir
	if _, err := os.Stat(target); os.IsNotExist(err) {
		target = filepath.Dir(target)
	}
	var st syscall.Statfs_t
	if err := syscall.Statfs(target, &st); err != nil {
		return nil // cannot tell; let the backup try
	}
	free := int64(st.Bavail) * int64(st.Bsize)
	need := fi.Size() * 2
	if free < need {
		return fmt.Errorf("not enough free space in %s: %d MB free, need about %d MB (database is %d MB)",
			target, free/(1<<20), need/(1<<20), fi.Size()/(1<<20))
	}
	return nil
}

// recordBypass leaves a durable trace that --no-backup was used, so doctor.sh
// can surface it. A bypass nobody can see becomes the standard procedure.
func recordBypass(cfg *config.Config) error {
	dir := backupDirFor(cfg)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	line := fmt.Sprintf("%s --no-backup used\n", time.Now().UTC().Format(time.RFC3339))
	f, err := os.OpenFile(filepath.Join(dir, "no-backup.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(line)
	return err
}

func mustCwd() string {
	d, err := os.Getwd()
	if err != nil {
		return "."
	}
	return d
}

func main() {
	loadDotEnv()

	// ---- backup subcommand ------------------------------------------------
	// Usage: ./planner backup [--verify] [--prune]
	//
	// Backup lives in the binary because the binary is the only artifact
	// guaranteed to exist on an air-gapped host. scripts/backup.sh prefers the
	// sqlite3 CLI, which neither install-airgap.sh nor package-airgap.sh ships,
	// so on a real machine it silently falls back to a raw cp of a live WAL
	// database.
	if len(os.Args) >= 2 && os.Args[1] == "backup" {
		verify := true
		prune := true
		for _, a := range os.Args[2:] {
			switch a {
			case "--verify":
				verify = true
			case "--no-verify":
				verify = false
			case "--no-prune":
				prune = false
			default:
				fmt.Fprintf(os.Stderr, "Unknown backup flag %q\n\nUsage: planner backup [--no-verify] [--no-prune]\n", a)
				os.Exit(1)
			}
		}

		cfg := config.Load()
		if !strings.HasPrefix(cfg.DatabaseURL, "sqlite:") {
			// Postgres backup stays with pg_dump in scripts/backup.sh, which
			// hard-fails when the tool is missing rather than degrading.
			fmt.Fprintln(os.Stderr, "planner backup handles SQLite only. For Postgres use scripts/backup.sh (requires pg_dump).")
			os.Exit(1)
		}
		srcPath := strings.TrimPrefix(cfg.DatabaseURL, "sqlite:")
		backupDir := os.Getenv("BACKUP_DIR")
		if backupDir == "" {
			backupDir = filepath.Join(filepath.Dir(srcPath), "backups")
		}

		res, err := db.BackupSQLite(srcPath, backupDir, verify)
		if err != nil {
			log.Fatalf("backup: %v", err)
		}
		fmt.Printf("Backup written: %s\n", res.Path)
		fmt.Printf("  source        %s\n", res.SourcePath)
		fmt.Printf("  bytes         %d\n", res.Bytes)
		fmt.Printf("  verified      %v\n", res.Verified)
		if res.Verified {
			fmt.Printf("  rows          users=%d planners=%d activities=%d\n",
				res.RowCounts["users"], res.RowCounts["planners"], res.RowCounts["activities"])
			fmt.Printf("  schema        %d applied, latest %s\n", res.Migrations, res.LatestMigra)
		}
		if prune {
			removed, err := db.PruneBackups(backupDir, backupKeepN(), backupMaxAge())
			if err == nil && len(removed) > 0 {
				fmt.Printf("  pruned        %d old backup(s)\n", len(removed))
			}
		}
		return
	}

	// ---- migrate subcommand -----------------------------------------------
	// Usage: ./planner migrate [status|dry-run|apply]
	// Must be checked before config.Load() so it can work without JWT_SECRET
	// when just printing usage, but in practice DB + JWT are needed, so we
	// do full init for the DB-touching subcommands.
	if len(os.Args) >= 2 && os.Args[1] == "migrate" {
		sub := "apply"
		if len(os.Args) >= 3 {
			sub = os.Args[2]
		}
		noBackup := false
		for _, a := range os.Args[3:] {
			if a == "--no-backup" {
				noBackup = true
			}
		}

		switch sub {
		case "status", "dry-run", "apply":
			// Need DB + config — proceed with normal init.
		default:
			fmt.Fprintf(os.Stderr, "Unknown migrate subcommand %q\n\nUsage: planner migrate [status|dry-run|apply]\n", sub)
			os.Exit(1)
		}

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

		switch sub {
		case "status":
			applied, err := db.ListApplied(database)
			if err != nil {
				log.Fatalf("list applied: %v", err)
			}
			pending, err := db.ListPending(database)
			if err != nil {
				log.Fatalf("list pending: %v", err)
			}
			fmt.Printf("%-50s  %-25s  %s\n", "MIGRATION", "APPLIED AT", "STATE")
			fmt.Printf("%s\n", strings.Repeat("-", 85))
			for _, m := range applied {
				fmt.Printf("%-50s  %-25s  applied\n", m.Filename, m.AppliedAt.UTC().Format(time.RFC3339))
			}
			for _, m := range pending {
				fmt.Printf("%-50s  %-25s  pending\n", m.Filename, "—")
			}
			fmt.Printf("\nApplied: %d  Pending: %d\n", len(applied), len(pending))
			return

		case "dry-run":
			pending, err := db.ListPending(database)
			if err != nil {
				log.Fatalf("list pending: %v", err)
			}
			if len(pending) == 0 {
				fmt.Println("No pending migrations.")
				return
			}
			fmt.Printf("%-45s  %10s  %s\n", "FILENAME", "SIZE", "FIRST SQL")
			fmt.Printf("%s\n", strings.Repeat("-", 100))
			for _, m := range pending {
				// Re-read first statement from embedded FS via ListPending data
				// We call FirstStatement on the filename by reading from the embed.
				// Since we can't import the private migrationsFS, read the file path:
				// db.FirstStatement takes a SQL string, not a path. So we need the content.
				// We'll use the fact that ListPending already read the file; call a helper.
				sqlContent := migrationContent(m.Filename)
				first := db.FirstStatement(sqlContent)
				fmt.Printf("%-45s  %10d  %s\n", m.Filename, m.Bytes, first)
			}
			return

		case "apply":
			pending, err := db.ListPending(database)
			if err != nil {
				log.Fatalf("list pending: %v", err)
			}
			// Nothing to do means nothing to protect. Without this, apply would
			// take a full-size backup every time it was run on an up-to-date
			// install, which on a small fixed disk is how a safety feature
			// becomes an outage.
			if len(pending) == 0 {
				fmt.Println("No pending migrations. Nothing to do.")
				return
			}

			if noBackup {
				// Loud on purpose. This is the bypass that becomes a ritual if
				// nobody can see it being used, so doctor.sh reports it.
				log.Printf("WARNING: --no-backup given; applying %d migration(s) with NO backup", len(pending))
				if err := recordBypass(cfg); err != nil {
					log.Printf("warning: could not record --no-backup use: %v", err)
				}
			} else {
				if err := backupBeforeMigrate(cfg, len(pending)); err != nil {
					log.Fatalf("refusing to migrate: %v\n\nFix the backup, or re-run with --no-backup to proceed without one.", err)
				}
			}

			if err := db.Migrate(database); err != nil {
				log.Fatalf("migration: %v", err)
			}
			fmt.Printf("Applied %d migration(s).\n", len(pending))
			return
		}
	}

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

	if cfg.MigrateOnStartup {
		if err := db.Migrate(database); err != nil {
			log.Fatalf("migration: %v", err)
		}
	} else if pending, err := db.ListPending(database); err == nil && len(pending) > 0 {
		// Refuse to start rather than migrating behind the operator's back.
		// Exiting non-zero is deliberate: under systemd a silent start with a
		// half-expected schema is worse than a failed one, and the message has
		// to carry the exact command because the box may have no shell access.
		log.Printf("%d pending migration(s) and MIGRATE_ON_STARTUP=false:", len(pending))
		for _, m := range pending {
			log.Printf("  %s", m.Filename)
		}
		log.Fatalf("refusing to start. Apply them first:\n\n    cd %s && ./planner migrate apply\n",
			mustCwd())
	}

	// Seed allow_registration from env on first run; thereafter the DB value wins.
	{
		var n int
		_ = database.QueryRow(database.Rebind(
			"SELECT COUNT(*) FROM app_settings WHERE key = ?"), "allow_registration").Scan(&n)
		if n == 0 {
			v := "true"
			if !cfg.AllowRegistration {
				v = "false"
			}
			_, _ = database.Exec(database.Rebind(
				"INSERT INTO app_settings(key, value) VALUES (?, ?)"),
				"allow_registration", v)
		}
	}

	// --create-admin subcommand: seed an admin user and exit. Used by the
	// air-gapped installer after first startup.
	if len(os.Args) > 1 && os.Args[1] == "--create-admin" {
		if err := runCreateAdmin(database, os.Args[2:]); err != nil {
			log.Fatalf("create-admin: %v", err)
		}
		return
	}

	mux := http.NewServeMux()

	// --- Public endpoints (no auth, no rate limit) -------------------------

	// Health probe
	healthH := health.NewHandler(database, Version)
	healthH.Register(mux)

	// Branding (app name / logo)
	brandingH := branding.NewHandler(cfg)
	brandingH.Register(mux)

	// Client-side error reporting (self-rate-limited internally)
	ceH := clienterrors.NewHandler()
	ceH.Register(mux)

	// --- Auth routes (own rate limiting via register/login throttles) ------
	authH := auth.NewHandler(database, cfg)
	// Brute-force defence: tight per-IP token bucket on the unauthenticated
	// credential endpoints (separate from the general mutation limiter).
	authLimit := middleware.AuthAttempts(cfg.TrustProxy)
	mux.HandleFunc("POST /api/auth/register", authLimit(http.HandlerFunc(authH.Register)).ServeHTTP)
	mux.HandleFunc("POST /api/auth/login", authLimit(http.HandlerFunc(authH.Login)).ServeHTTP)
	mux.HandleFunc("POST /api/auth/logout", authH.Logout)
	mux.HandleFunc("GET /api/auth/me", middleware.RequireAuth(cfg, database, authH.Me))
	mux.HandleFunc("GET /api/users", middleware.RequireAuth(cfg, database, authH.SearchUsers))
	mux.HandleFunc("GET /api/auth/gitlab/status", authH.GitLabStatus)
	mux.HandleFunc("GET /api/auth/gitlab/authorize", authH.GitLabAuthorize)
	mux.HandleFunc("GET /api/auth/gitlab/callback", authH.GitLabCallback)
	mux.HandleFunc("GET /api/auth/registration-status", authH.RegistrationStatus)

	// Mutation rate limiter — applied to all planner/share/group/import mutations.
	mutLimit := middleware.Mutations()

	// --- Planner CRUD routes -----------------------------------------------
	planH := planners.NewHandler(database, cfg)
	mux.HandleFunc("GET /api/planners", middleware.RequireAuth(cfg, database, planH.List))
	mux.HandleFunc("POST /api/planners", middleware.RequireAuth(cfg, database, mutLimit(http.HandlerFunc(planH.Create)).ServeHTTP))
	mux.HandleFunc("GET /api/planners/public", middleware.RequireAuth(cfg, database, planH.ListPublic))
	mux.HandleFunc("GET /api/planners/{id}", middleware.RequireAuth(cfg, database, planH.Get))
	mux.HandleFunc("GET /api/planners/{id}/members", middleware.RequireAuth(cfg, database, planH.Members))
	mux.HandleFunc("PUT /api/planners/{id}", middleware.RequireAuth(cfg, database, mutLimit(http.HandlerFunc(planH.Update)).ServeHTTP))
	mux.HandleFunc("DELETE /api/planners/{id}", middleware.RequireAuth(cfg, database, mutLimit(http.HandlerFunc(planH.Delete)).ServeHTTP))
	mux.HandleFunc("POST /api/planners/{id}/duplicate", middleware.RequireAuth(cfg, database, mutLimit(http.HandlerFunc(planH.Duplicate)).ServeHTTP))

	// --- Share management routes -------------------------------------------
	shareH := share.NewHandler(database, cfg)
	mux.HandleFunc("GET /api/planners/{plannerID}/shares", middleware.RequireAuth(cfg, database, shareH.List))
	mux.HandleFunc("POST /api/planners/{plannerID}/shares", middleware.RequireAuth(cfg, database, mutLimit(http.HandlerFunc(shareH.Create)).ServeHTTP))
	mux.HandleFunc("DELETE /api/planners/{plannerID}/shares/{userID}", middleware.RequireAuth(cfg, database, mutLimit(http.HandlerFunc(shareH.Delete)).ServeHTTP))
	mux.HandleFunc("GET /api/planners/{plannerID}/shares/group-shares", middleware.RequireAuth(cfg, database, shareH.ListGroupShares))
	mux.HandleFunc("POST /api/planners/{plannerID}/shares/group-shares", middleware.RequireAuth(cfg, database, mutLimit(http.HandlerFunc(shareH.CreateGroupShare)).ServeHTTP))
	mux.HandleFunc("DELETE /api/planners/{plannerID}/shares/group-shares/{groupID}", middleware.RequireAuth(cfg, database, mutLimit(http.HandlerFunc(shareH.DeleteGroupShare)).ServeHTTP))
	mux.HandleFunc("PUT /api/planners/{plannerID}/shares/group-shares/{groupID}/overrides/{userID}", middleware.RequireAuth(cfg, database, mutLimit(http.HandlerFunc(shareH.UpsertGroupMemberOverride)).ServeHTTP))
	mux.HandleFunc("DELETE /api/planners/{plannerID}/shares/group-shares/{groupID}/overrides/{userID}", middleware.RequireAuth(cfg, database, mutLimit(http.HandlerFunc(shareH.DeleteGroupMemberOverride)).ServeHTTP))

	// --- Share token routes (public link generation) -----------------------
	mux.HandleFunc("POST /api/planners/{plannerID}/share-tokens", middleware.RequireAuth(cfg, database, mutLimit(http.HandlerFunc(shareH.CreateShareToken)).ServeHTTP))
	mux.HandleFunc("GET /api/planners/{plannerID}/share-tokens", middleware.RequireAuth(cfg, database, shareH.ListShareTokens))
	mux.HandleFunc("POST /api/planners/{plannerID}/share-tokens/{token}/revoke", middleware.RequireAuth(cfg, database, mutLimit(http.HandlerFunc(shareH.RevokeShareToken)).ServeHTTP))

	// --- Public (unauthenticated) planner read endpoint -------------------
	publicH := publicread.NewHandler(database)
	mux.HandleFunc("GET /api/public/planners/{token}", publicH.GetPublic)

	// --- Saved views -------------------------------------------------------
	viewsH := views.NewHandler(database, cfg)
	mux.HandleFunc("GET /api/planners/{plannerID}/views", middleware.RequireAuth(cfg, database, viewsH.List))
	mux.HandleFunc("POST /api/planners/{plannerID}/views", middleware.RequireAuth(cfg, database, mutLimit(http.HandlerFunc(viewsH.Create)).ServeHTTP))
	mux.HandleFunc("DELETE /api/planners/{plannerID}/views/{viewID}", middleware.RequireAuth(cfg, database, mutLimit(http.HandlerFunc(viewsH.Delete)).ServeHTTP))

	// --- Calendar file import (.ics / .csv) --------------------------------
	importH := importing.NewHandler(database, cfg)
	mux.HandleFunc("POST /api/planners/{id}/import", middleware.RequireAuth(cfg, database, mutLimit(http.HandlerFunc(importH.Import)).ServeHTTP))

	// --- Groups -----------------------------------------------------------
	groupsH := groups.NewHandler(database, cfg)
	groupsH.Register(mux, cfg, database)

	// --- Search -----------------------------------------------------------
	searchH := search.New(database)
	searchH.Register(mux, func(fn http.HandlerFunc) http.HandlerFunc {
		return middleware.RequireAuth(cfg, database, fn)
	})

	// --- Admin ------------------------------------------------------------
	adminH := admin.NewHandler(database)
	requireAdmin := func(fn http.HandlerFunc) http.HandlerFunc {
		return middleware.RequireAdmin(cfg, database, fn)
	}
	mux.HandleFunc("GET /api/admin/users", requireAdmin(adminH.ListUsers))
	mux.HandleFunc("PATCH /api/admin/users/{id}", requireAdmin(mutLimit(http.HandlerFunc(adminH.UpdateUser)).ServeHTTP))
	mux.HandleFunc("DELETE /api/admin/users/{id}", requireAdmin(mutLimit(http.HandlerFunc(adminH.DeleteUser)).ServeHTTP))
	mux.HandleFunc("GET /api/admin/groups", requireAdmin(adminH.ListGroups))
	mux.HandleFunc("GET /api/admin/groups/{id}/members", requireAdmin(adminH.ListGroupMembers))
	mux.HandleFunc("POST /api/admin/groups/{id}/members", requireAdmin(mutLimit(http.HandlerFunc(adminH.AddGroupMember)).ServeHTTP))
	mux.HandleFunc("PATCH /api/admin/groups/{id}/members/{userID}", requireAdmin(mutLimit(http.HandlerFunc(adminH.UpdateGroupMember)).ServeHTTP))
	mux.HandleFunc("DELETE /api/admin/groups/{id}/members/{userID}", requireAdmin(mutLimit(http.HandlerFunc(adminH.RemoveGroupMember)).ServeHTTP))
	mux.HandleFunc("GET /api/admin/settings", requireAdmin(adminH.GetSettings))
	mux.HandleFunc("PATCH /api/admin/settings", requireAdmin(mutLimit(http.HandlerFunc(adminH.PatchSettings)).ServeHTTP))

	// --- Favicon (default embedded + admin-uploadable override) -----------
	faviconH := favicon.NewHandler(database, cfg, func() ([]byte, error) {
		return publicFS.ReadFile("public/favicon.svg")
	})
	faviconH.RegisterPublic(mux)
	mux.HandleFunc("GET /api/admin/favicon", requireAdmin(faviconH.GetStatus))
	mux.HandleFunc("POST /api/admin/favicon", requireAdmin(mutLimit(http.HandlerFunc(faviconH.Upload)).ServeHTTP))
	mux.HandleFunc("DELETE /api/admin/favicon", requireAdmin(mutLimit(http.HandlerFunc(faviconH.Reset)).ServeHTTP))

	// Static files embedded from public/ (HTML, CSS, JS bundles)
	sub, err := fs.Sub(publicFS, "public")
	if err != nil {
		log.Fatalf("embed.Sub: %v", err)
	}
	// Layer: StaticCache (ETag/Cache-Control) → Compress (gzip) → FileServer.
	// Applied to the static handler only — NOT to /api/ routes.
	staticH := middleware.NewStaticCache(sub, middleware.Compress(http.FileServer(http.FS(sub))))
	mux.Handle("/", spaHandler(staticH))

	// Build the full middleware chain: RequestID → JSONLogger → securityHeaders → routes
	chain := middleware.RequestID(
		middleware.JSONLogger(
			securityHeaders(cfg.AllowedOrigin, cfg.TrustProxy)(mux),
		),
	)

	startServers(cfg, chain)
}

// migrationContent reads a migration file by name (e.g. "001-initial.sql").
// It tries the canonical source path first, then falls back to the working
// directory. Returns "" if the file cannot be read (dry-run still works,
// the first-sql column will just be blank).
func migrationContent(filename string) string {
	// Canonical source location when running from the project root.
	data, err := os.ReadFile("internal/db/migrations/" + filename)
	if err == nil {
		return string(data)
	}
	// Fallback: flat "migrations/" directory beside the binary.
	data, err = os.ReadFile("migrations/" + filename)
	if err == nil {
		return string(data)
	}
	return ""
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

func securityHeaders(allowedOrigin string, trustProxy bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("X-Frame-Options", "DENY")
			w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
			w.Header().Set("Content-Security-Policy",
				"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'")
			// HSTS: only set when the connection is over TLS to avoid downgrade loops.
			if r.TLS != nil {
				w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
			}
			// Reject cross-origin API calls from unexpected origins.
			// Allow requests whose Origin matches either the configured ALLOWED_ORIGIN
			// or the server's own scheme+host (so any IP/hostname the server is
			// actually serving from is treated as same-origin).
			if origin := r.Header.Get("Origin"); origin != "" && strings.HasPrefix(r.URL.Path, "/api/") {
				scheme := "http"
				if r.TLS != nil || (trustProxy && r.Header.Get("X-Forwarded-Proto") == "https") {
					scheme = "https"
				}
				if origin != allowedOrigin && origin != scheme+"://"+r.Host {
					http.Error(w, "Forbidden", http.StatusForbidden)
					return
				}
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
