// Package settings provides read/write access to the app_settings table,
// which stores operator-configurable flags that can be changed at runtime
// without restarting the server.
package settings

import (
	"context"

	"planner/internal/db"
)

// GetBool reads a boolean setting from app_settings by key.
// Returns fallback if the row does not exist or cannot be read.
func GetBool(ctx context.Context, database *db.DB, key string, fallback bool) bool {
	var v string
	err := database.QueryRowContext(ctx,
		database.Rebind("SELECT value FROM app_settings WHERE key = ?"), key).Scan(&v)
	if err != nil {
		return fallback
	}
	return v == "true" || v == "1"
}

// SetBool writes a boolean setting to app_settings, upserting the row.
// updated_at is set explicitly so both SQLite and Postgres stay in sync
// (Postgres has no column-level ON UPDATE trigger).
func SetBool(ctx context.Context, database *db.DB, key string, val bool) error {
	v := "false"
	if val {
		v = "true"
	}
	return setRaw(ctx, database, key, v)
}

// GetString reads a string setting from app_settings by key.
// Returns fallback if the row does not exist or cannot be read.
func GetString(ctx context.Context, database *db.DB, key, fallback string) string {
	var v string
	err := database.QueryRowContext(ctx,
		database.Rebind("SELECT value FROM app_settings WHERE key = ?"), key).Scan(&v)
	if err != nil {
		return fallback
	}
	return v
}

// SetString writes a string setting, upserting the row.
func SetString(ctx context.Context, database *db.DB, key, val string) error {
	return setRaw(ctx, database, key, val)
}

// Delete removes a setting row. Idempotent (no error if missing).
func Delete(ctx context.Context, database *db.DB, key string) error {
	_, err := database.ExecContext(ctx,
		database.Rebind("DELETE FROM app_settings WHERE key = ?"), key)
	return err
}

func setRaw(ctx context.Context, database *db.DB, key, val string) error {
	var nowExpr string
	if database.Dialect == db.Postgres {
		nowExpr = "NOW()"
	} else {
		nowExpr = "(strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
	}

	_, err := database.ExecContext(ctx, database.Rebind(`
		INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, `+nowExpr+`)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = `+nowExpr+`
	`), key, val)
	return err
}
