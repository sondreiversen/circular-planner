package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"strings"

	"golang.org/x/crypto/bcrypt"
	"planner/internal/db"
)

// runCreateAdmin seeds an admin user record. Invoked by `./planner --create-admin
// --username U --email E --password P`. Used by the air-gapped installer.
func runCreateAdmin(database *db.DB, args []string) error {
	fs := flag.NewFlagSet("create-admin", flag.ContinueOnError)
	username := fs.String("username", "", "admin username")
	email := fs.String("email", "", "admin email")
	password := fs.String("password", "", "admin password (min 8 chars)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	u := strings.TrimSpace(*username)
	e := strings.ToLower(strings.TrimSpace(*email))
	p := *password

	if u == "" || e == "" || p == "" {
		return errors.New("--username, --email, and --password are all required")
	}
	if len(p) < 8 {
		return errors.New("password must be at least 8 characters")
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(p), 10)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}

	ctx := context.Background()

	// Idempotent: if the email already exists, promote to admin and report success.
	var existingID int
	if err := database.QueryRowContext(ctx,
		database.Rebind("SELECT id FROM users WHERE email = ?"), e,
	).Scan(&existingID); err == nil {
		if _, err := database.ExecContext(ctx,
			database.Rebind("UPDATE users SET is_admin = 1 WHERE id = ?"), existingID,
		); err != nil {
			return fmt.Errorf("promote existing user: %w", err)
		}
		fmt.Printf("Admin user %q (%s) already exists — promoted to admin.\n", u, e)
		return nil
	}

	var id int
	if err := database.QueryRowContext(ctx,
		database.Rebind(`INSERT INTO users(username, email, password_hash, is_admin)
		                 VALUES (?, ?, ?, 1) RETURNING id`),
		u, e, string(hash),
	).Scan(&id); err != nil {
		return fmt.Errorf("insert user: %w", err)
	}

	fmt.Printf("Created admin user %q (%s) with id %d.\n", u, e, id)
	return nil
}
