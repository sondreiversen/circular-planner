// Package db provides a thin wrapper around database/sql that normalises
// SQLite and PostgreSQL into a single interface with automatic placeholder
// translation (? → $N for Postgres).
package db

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	// drivers registered via side-effect imports in the open functions
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

// Dialect identifies the underlying database engine.
type Dialect int

const (
	SQLite   Dialect = iota
	Postgres Dialect = iota
)

// DB wraps *sql.DB and adds dialect-aware helpers.
type DB struct {
	*sql.DB
	Dialect Dialect
}

// Open opens a database from a URL.
//   - URLs starting with "postgres://" or "postgresql://" use Postgres.
//   - URLs starting with "sqlite:" use SQLite (path after the colon).
//   - Bare paths (no scheme) are treated as SQLite file paths.
func Open(url string) (*DB, error) {
	switch {
	case strings.HasPrefix(url, "postgres://") || strings.HasPrefix(url, "postgresql://"):
		sqldb, err := sql.Open("pgx", url)
		if err != nil {
			return nil, fmt.Errorf("open postgres: %w", err)
		}
		sqldb.SetMaxOpenConns(25)
		sqldb.SetMaxIdleConns(5)
		sqldb.SetConnMaxLifetime(5 * time.Minute)
		return &DB{DB: sqldb, Dialect: Postgres}, nil

	default:
		path := strings.TrimPrefix(url, "sqlite:")
		// Enable WAL mode and foreign keys via DSN pragmas
		dsn := path + "?_pragma=journal_mode(WAL)&_pragma=foreign_keys(ON)"
		sqldb, err := sql.Open("sqlite", dsn)
		if err != nil {
			return nil, fmt.Errorf("open sqlite: %w", err)
		}
		sqldb.SetMaxOpenConns(1) // SQLite doesn't support concurrent writers
		return &DB{DB: sqldb, Dialect: SQLite}, nil
	}
}

// Rebind converts ? placeholders to $1, $2, ... for Postgres.
// For SQLite the query is returned unchanged.
func (db *DB) Rebind(query string) string {
	if db.Dialect == SQLite {
		return query
	}
	var b strings.Builder
	n := 1
	for i := 0; i < len(query); i++ {
		if query[i] == '?' {
			fmt.Fprintf(&b, "$%d", n)
			n++
		} else {
			b.WriteByte(query[i])
		}
	}
	return b.String()
}

// DateStr is a sql.Scanner that accepts both string and time.Time values and
// normalises them to "YYYY-MM-DD" strings. This lets the same scan work against
// both SQLite (TEXT dates) and Postgres (DATE / TIMESTAMPTZ columns).
type DateStr string

func (d *DateStr) Scan(src any) error {
	switch v := src.(type) {
	case string:
		if len(v) >= 10 {
			*d = DateStr(v[:10])
		} else {
			*d = DateStr(v)
		}
	case []byte:
		s := string(v)
		if len(s) >= 10 {
			*d = DateStr(s[:10])
		} else {
			*d = DateStr(s)
		}
	case time.Time:
		*d = DateStr(v.Format("2006-01-02"))
	case nil:
		*d = ""
	default:
		return fmt.Errorf("DateStr: cannot scan %T", src)
	}
	return nil
}

func (d DateStr) String() string { return string(d) }

// NullInt64 is a helper for nullable integer columns.
type NullInt64 = sql.NullInt64
