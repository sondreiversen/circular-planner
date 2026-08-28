package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Backup writes a consistent copy of the database and verifies it.
//
// This lives in the binary rather than in scripts/backup.sh for one reason:
// the binary is the only artifact guaranteed to exist on an air-gapped host.
// backup.sh's safe path shells out to the sqlite3 CLI, which neither
// install-airgap.sh nor package-airgap.sh ever installs, so on a real machine
// it silently falls back to a raw cp of a live WAL database.
//
// SQLite uses VACUUM INTO. Verified behaviour, not assumed:
//
//   - Consistent under a live concurrent writer. It is NOT atomic — the dump is
//     a transactionally consistent point-in-time snapshot as of the START of its
//     read transaction. Writes committed while it runs are not in the copy.
//   - Non-blocking only because the app opens SQLite in journal_mode(WAL)
//     (db.go:75). Under a rollback journal the same read transaction would block
//     every writer for its full duration. WAL is a load-bearing precondition.
//   - Refuses a destination that already exists ("output file already exists"),
//     so a killed backup poisons its own retry unless the leftover is cleared.
//   - Refuses to run inside a transaction ("cannot VACUUM from within a
//     transaction"), which is why this opens its own connection.

// BackupResult describes a completed backup. It is written to disk as the
// manifest, and the manifest is written LAST so its presence is the commit
// record for the whole operation.
type BackupResult struct {
	Path        string         `json:"path"`
	SourcePath  string         `json:"source_path"`
	Bytes       int64          `json:"bytes"`
	TakenAt     time.Time      `json:"taken_at"`
	RowCounts   map[string]int `json:"row_counts"`
	Migrations  int            `json:"migrations_applied"`
	LatestMigra string         `json:"latest_migration"`
	Verified    bool           `json:"verified"`
}

// countedTables are compared between source and dump during verification.
// They are the tables whose loss would be noticed: accounts, the planners
// themselves, and the activities inside them.
var countedTables = []string{"users", "planners", "activities"}

// BackupSQLite writes a verified snapshot of a SQLite database to dir.
//
// srcPath must already exist. That check is not paranoia: loadDotEnv reads
// .env from the current working directory and DATABASE_URL is relative
// ("sqlite:./data/planner.db"), so running this from the wrong directory would
// otherwise create an empty database, snapshot it, pass every integrity check,
// and produce a backup of nothing that looks exactly like success.
func BackupSQLite(srcPath, dir string, verify bool) (*BackupResult, error) {
	abs, err := filepath.Abs(srcPath)
	if err != nil {
		return nil, fmt.Errorf("resolve %s: %w", srcPath, err)
	}
	fi, err := os.Stat(abs)
	if err != nil {
		return nil, fmt.Errorf("refusing to back up %s: %w (run this from the install directory, or set DATABASE_URL)", abs, err)
	}
	if fi.IsDir() {
		return nil, fmt.Errorf("refusing to back up %s: it is a directory", abs)
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create backup dir: %w", err)
	}

	// Absolute, so the manifest is unambiguous about where the dump lives. A
	// recovery artifact that records a relative path is only useful to someone
	// who already knows which directory it was written from.
	absDir, err := filepath.Abs(dir)
	if err != nil {
		return nil, fmt.Errorf("resolve backup dir: %w", err)
	}
	stamp := time.Now().UTC().Format("20060102-150405")
	final := filepath.Join(absDir, fmt.Sprintf("planner-%s.sqlite", stamp))
	partial := final + ".partial"

	// VACUUM INTO refuses an existing destination, so a leftover from a killed
	// run would break the retry rather than being overwritten.
	if err := os.Remove(partial); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("clear stale partial %s: %w", partial, err)
	}

	src, err := openPlain(abs)
	if err != nil {
		return nil, err
	}
	defer src.Close()

	if _, err := src.Exec("VACUUM INTO ?", partial); err != nil {
		os.Remove(partial)
		return nil, fmt.Errorf("vacuum into %s: %w", partial, err)
	}

	res := &BackupResult{
		Path:       final,
		SourcePath: abs,
		TakenAt:    time.Now().UTC(),
		RowCounts:  map[string]int{},
	}

	if verify {
		if err := verifyDump(src, partial, res); err != nil {
			os.Remove(partial)
			return nil, err
		}
		res.Verified = true
	}

	if err := os.Rename(partial, final); err != nil {
		os.Remove(partial)
		return nil, fmt.Errorf("promote %s: %w", partial, err)
	}
	if st, err := os.Stat(final); err == nil {
		res.Bytes = st.Size()
	}

	// Manifest last: its presence means everything above succeeded.
	if err := writeManifest(final, res); err != nil {
		return nil, fmt.Errorf("write manifest: %w", err)
	}
	return res, nil
}

// verifyDump reopens the dump and checks it is readable, structurally sound,
// and holds the same rows as the source.
//
// integrity_check alone would pass on a perfectly valid backup of the wrong
// database, so the row comparison is what actually catches that case.
func verifyDump(src *sql.DB, dumpPath string, res *BackupResult) error {
	dump, err := openPlain(dumpPath)
	if err != nil {
		return fmt.Errorf("reopen dump: %w", err)
	}
	defer dump.Close()

	var integrity string
	if err := dump.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil {
		return fmt.Errorf("integrity_check: %w", err)
	}
	if integrity != "ok" {
		return fmt.Errorf("backup failed integrity_check: %s", integrity)
	}

	for _, t := range countedTables {
		var srcN, dumpN int
		if err := src.QueryRow("SELECT COUNT(*) FROM " + t).Scan(&srcN); err != nil {
			// A table that does not exist yet is not a failure — an early
			// schema legitimately lacks some of these.
			continue
		}
		if err := dump.QueryRow("SELECT COUNT(*) FROM " + t).Scan(&dumpN); err != nil {
			return fmt.Errorf("dump is missing table %s: %w", t, err)
		}
		// The dump may legitimately trail the source: it is a snapshot as of
		// read-transaction start and the source may have committed since. It
		// must never be AHEAD, and it must not be empty when the source is not.
		if dumpN > srcN {
			return fmt.Errorf("dump has more rows than source in %s (%d > %d)", t, dumpN, srcN)
		}
		if srcN > 0 && dumpN == 0 {
			return fmt.Errorf("dump has no rows in %s but source has %d — wrong database?", t, srcN)
		}
		res.RowCounts[t] = dumpN
	}

	// Schema state, expressed the only way this project can: there is no
	// version integer, schema_migrations stores filenames (migrate.go:206).
	rows, err := dump.Query("SELECT filename FROM schema_migrations")
	if err == nil {
		defer rows.Close()
		var names []string
		for rows.Next() {
			var n string
			if rows.Scan(&n) == nil {
				names = append(names, n)
			}
		}
		sort.Strings(names)
		res.Migrations = len(names)
		if len(names) > 0 {
			res.LatestMigra = names[len(names)-1]
		}
	}
	return nil
}

// openPlain opens SQLite without the app's connection settings.
//
// Deliberately not db.Open: that pins SetMaxOpenConns(1) and temp_store(MEMORY)
// (db.go:81,86). The single connection would deadlock any in-process caller
// holding a Tx, and an in-memory temp store makes a vacuum's index rebuild sort
// in RAM, which is the wrong trade on a small air-gapped box.
func openPlain(path string) (*sql.DB, error) {
	h, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(10000)")
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	if err := h.Ping(); err != nil {
		h.Close()
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	return h, nil
}

func writeManifest(dumpPath string, res *BackupResult) error {
	b, err := json.MarshalIndent(res, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(manifestPath(dumpPath), append(b, '\n'), 0o644)
}

func manifestPath(dumpPath string) string {
	return strings.TrimSuffix(dumpPath, filepath.Ext(dumpPath)) + ".manifest.json"
}

// PruneBackups enforces both a keep-last-N cap and an age limit.
//
// scripts/backup.sh prunes by age alone (-mtime +14). That does not bound a
// retry burst: three failed upgrade attempts in one afternoon leave three
// full-size dumps that nothing removes for two weeks, on the same disk they
// protect. Since `migrate apply` now takes a backup on every run, the count cap
// is the one that actually matters.
//
// keepN <= 0 disables the count cap; maxAge <= 0 disables the age cap. The
// newest keepN dumps are always retained regardless of age, so a long-idle
// instance never prunes itself down to nothing.
func PruneBackups(dir string, keepN int, maxAge time.Duration) (removed []string, err error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	type dump struct {
		path string
		mod  time.Time
	}
	var dumps []dump
	for _, e := range entries {
		if e.IsDir() || !strings.HasPrefix(e.Name(), "planner-") || !strings.HasSuffix(e.Name(), ".sqlite") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		dumps = append(dumps, dump{filepath.Join(dir, e.Name()), info.ModTime()})
	}
	// Newest first.
	sort.Slice(dumps, func(i, j int) bool { return dumps[i].mod.After(dumps[j].mod) })

	now := time.Now()
	for i, d := range dumps {
		// The newest keepN are protected unconditionally. Without this, the age
		// rule would prune a long-idle instance down to nothing — every dump is
		// old when nobody has upgraded in three months.
		if keepN > 0 && i < keepN {
			continue
		}
		overCount := keepN > 0
		overAge := maxAge > 0 && now.Sub(d.mod) > maxAge
		if !overCount && !overAge {
			continue
		}
		if err := os.Remove(d.path); err != nil {
			continue
		}
		// The manifest is the commit record; it goes with its dump.
		os.Remove(manifestPath(d.path))
		removed = append(removed, d.path)
	}
	return removed, nil
}
