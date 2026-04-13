package db

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log"
	"sort"
	"strings"
)

//go:embed migrations
var migrationsFS embed.FS

// Migrate applies pending SQL migrations from the embedded migrations/ directory.
// Migrations are tracked in the schema_migrations table and applied in
// lexicographic (filename) order.
func Migrate(database *DB) error {
	ctx := context.Background()

	// Ensure tracking table exists. For Postgres we use SERIAL; for SQLite INTEGER PRIMARY KEY.
	var createMigrations string
	if database.Dialect == Postgres {
		createMigrations = `CREATE TABLE IF NOT EXISTS schema_migrations (
			filename   TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`
	} else {
		createMigrations = `CREATE TABLE IF NOT EXISTS schema_migrations (
			filename   TEXT PRIMARY KEY,
			applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
		)`
	}
	if _, err := database.ExecContext(ctx, createMigrations); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	// List SQL files
	entries, err := fs.ReadDir(migrationsFS, "migrations")
	if err != nil {
		return fmt.Errorf("read migrations dir: %w", err)
	}
	var files []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)

	for _, name := range files {
		// Check if already applied
		var count int
		row := database.QueryRowContext(ctx, database.Rebind("SELECT COUNT(*) FROM schema_migrations WHERE filename = ?"), name)
		if err := row.Scan(&count); err != nil {
			return fmt.Errorf("check migration %s: %w", name, err)
		}
		if count > 0 {
			log.Printf("  [skip] %s", name)
			continue
		}

		data, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			return fmt.Errorf("read %s: %w", name, err)
		}

		sql := translateSQL(string(data), database.Dialect)

		tx, err := database.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("begin tx for %s: %w", name, err)
		}

		// Execute migration SQL (may be multiple statements)
		stmts := splitStatements(sql)
		for _, stmt := range stmts {
			stmt = strings.TrimSpace(stmt)
			if stmt == "" {
				continue
			}
			if _, err := tx.ExecContext(ctx, stmt); err != nil {
				_ = tx.Rollback()
				return fmt.Errorf("apply %s: %w\nSQL: %s", name, err, stmt)
			}
		}

		// Record migration
		if _, err := tx.ExecContext(ctx,
			database.Rebind("INSERT INTO schema_migrations(filename) VALUES (?)"), name); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("record %s: %w", name, err)
		}

		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit %s: %w", name, err)
		}
		log.Printf("  [done] %s", name)
	}

	log.Println("Migrations complete.")
	return nil
}

// translateSQL rewrites SQLite-style SQL to Postgres where needed (or vice versa).
func translateSQL(sql string, dialect Dialect) string {
	if dialect == Postgres {
		// Rewrite SQLite timestamp default
		sql = strings.ReplaceAll(sql, "strftime('%Y-%m-%dT%H:%M:%SZ','now')", "NOW()")
		sql = strings.ReplaceAll(sql, "(strftime('%Y-%m-%dT%H:%M:%SZ','now'))", "NOW()")
		// Promote TEXT dates to proper types in CREATE TABLE (for fresh Postgres installs)
		// We do this with targeted replacements in the column definitions.
		// INTEGER PRIMARY KEY → BIGSERIAL PRIMARY KEY (auto-increment for Postgres)
		sql = strings.ReplaceAll(sql, "INTEGER PRIMARY KEY,", "BIGSERIAL PRIMARY KEY,")
		sql = strings.ReplaceAll(sql, "INTEGER PRIMARY KEY\n", "BIGSERIAL PRIMARY KEY\n")
		// TEXT dates → TIMESTAMPTZ for created_at / applied_at
		sql = strings.ReplaceAll(sql, "applied_at TEXT NOT NULL DEFAULT NOW()", "applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()")
		sql = strings.ReplaceAll(sql, "created_at TEXT NOT NULL DEFAULT NOW()", "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()")
		sql = strings.ReplaceAll(sql, "updated_at TEXT NOT NULL DEFAULT NOW()", "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()")
	}
	return sql
}

// splitStatements splits a SQL string on semicolons, preserving non-empty statements.
func splitStatements(sql string) []string {
	raw := strings.Split(sql, ";")
	var out []string
	for _, s := range raw {
		if t := strings.TrimSpace(s); t != "" {
			out = append(out, t)
		}
	}
	return out
}
