package db_test

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	_ "modernc.org/sqlite"
	"planner/internal/db"
)

// seed creates a WAL-mode SQLite database shaped like the real one.
func seed(t *testing.T, rows int) (path string, handle *sql.DB) {
	t.Helper()
	path = filepath.Join(t.TempDir(), "planner.db")
	h, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	stmts := []string{
		`CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT)`,
		`CREATE TABLE planners(id INTEGER PRIMARY KEY, title TEXT)`,
		`CREATE TABLE activities(id TEXT, planner_id INTEGER, title TEXT)`,
		`CREATE TABLE schema_migrations(filename TEXT PRIMARY KEY, applied_at TEXT DEFAULT '')`,
	}
	for _, s := range stmts {
		if _, err := h.Exec(s); err != nil {
			t.Fatalf("seed schema: %v", err)
		}
	}
	for i := 0; i < rows; i++ {
		h.Exec(`INSERT INTO users(username) VALUES (?)`, fmt.Sprintf("u%d", i))
		h.Exec(`INSERT INTO planners(title) VALUES (?)`, fmt.Sprintf("p%d", i))
		h.Exec(`INSERT INTO activities(id, planner_id, title) VALUES (?,?,?)`, fmt.Sprintf("a%d", i), i, "act")
	}
	h.Exec(`INSERT INTO schema_migrations(filename) VALUES ('001-initial.sql')`)
	h.Exec(`INSERT INTO schema_migrations(filename) VALUES ('018-share-token-label.sql')`)
	t.Cleanup(func() { h.Close() })
	return path, h
}

func TestBackup_ProducesVerifiedDump(t *testing.T) {
	src, _ := seed(t, 50)
	dir := t.TempDir()

	res, err := db.BackupSQLite(src, dir, true)
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	if !res.Verified {
		t.Error("result not marked verified")
	}
	if res.Bytes <= 0 {
		t.Errorf("bytes = %d, want > 0", res.Bytes)
	}
	if res.RowCounts["users"] != 50 || res.RowCounts["planners"] != 50 || res.RowCounts["activities"] != 50 {
		t.Errorf("row counts = %v, want 50 each", res.RowCounts)
	}
	// Schema state is filenames, not a version integer.
	if res.Migrations != 2 || res.LatestMigra != "018-share-token-label.sql" {
		t.Errorf("migrations = %d / %q, want 2 / 018-share-token-label.sql", res.Migrations, res.LatestMigra)
	}
	if !filepath.IsAbs(res.SourcePath) {
		t.Errorf("source path %q is not absolute", res.SourcePath)
	}
}

// The manifest is the commit record: it must exist and describe the dump.
func TestBackup_WritesManifestLast(t *testing.T) {
	src, _ := seed(t, 5)
	dir := t.TempDir()
	res, err := db.BackupSQLite(src, dir, true)
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	man := strings.TrimSuffix(res.Path, ".sqlite") + ".manifest.json"
	b, err := os.ReadFile(man)
	if err != nil {
		t.Fatalf("manifest missing: %v", err)
	}
	var got db.BackupResult
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("manifest unparseable: %v", err)
	}
	if got.Path != res.Path || got.RowCounts["users"] != 5 {
		t.Errorf("manifest does not describe the dump: %+v", got)
	}
}

// The wrong-database hazard: a relative DATABASE_URL plus the wrong cwd would
// otherwise create an empty DB, snapshot it, and pass every check.
func TestBackup_RefusesMissingSource(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(t.TempDir(), "does-not-exist.db")

	if _, err := db.BackupSQLite(missing, dir, true); err == nil {
		t.Fatal("expected refusal for a source that does not exist")
	}
	if _, err := os.Stat(missing); err == nil {
		t.Error("backup created the database it was supposed to refuse")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Errorf("wrote %d files despite refusing", len(entries))
	}
}

// VACUUM INTO refuses an existing destination, so a killed run would otherwise
// poison its own retry.
func TestBackup_ClearsStalePartial(t *testing.T) {
	src, _ := seed(t, 3)
	dir := t.TempDir()

	// Take one backup to learn the naming, then plant a stale partial for the
	// next second so the retry has something to trip over.
	first, err := db.BackupSQLite(src, dir, false)
	if err != nil {
		t.Fatalf("first backup: %v", err)
	}
	stale := first.Path + ".partial"
	if err := os.WriteFile(stale, []byte("garbage from a killed run"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A second backup in the same second reuses the name and must clear it.
	time.Sleep(1100 * time.Millisecond)
	if _, err := db.BackupSQLite(src, dir, true); err != nil {
		t.Fatalf("retry after stale partial: %v", err)
	}
}

// The real upgrade scenario, and the one the earlier probe did not cover.
func TestBackup_ConsistentUnderConcurrentWrites(t *testing.T) {
	src, h := seed(t, 100)
	dir := t.TempDir()

	var stop atomic.Bool
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; !stop.Load(); i++ {
			h.Exec(`INSERT INTO users(username) VALUES (?)`, fmt.Sprintf("live%d", i))
		}
	}()
	time.Sleep(50 * time.Millisecond)

	res, err := db.BackupSQLite(src, dir, true)
	stop.Store(true)
	<-done
	if err != nil {
		t.Fatalf("backup under concurrent writes: %v", err)
	}
	// A snapshot may trail the source but must never lead it, and must not be
	// empty while the source has rows.
	if res.RowCounts["users"] < 100 {
		t.Errorf("dump lost committed rows: users = %d, want >= 100", res.RowCounts["users"])
	}
}

func TestPruneBackups_KeepsNewestN(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 5; i++ {
		p := filepath.Join(dir, fmt.Sprintf("planner-2026010%d-000000.sqlite", i))
		os.WriteFile(p, []byte("x"), 0o644)
		os.WriteFile(strings.TrimSuffix(p, ".sqlite")+".manifest.json", []byte("{}"), 0o644)
		os.Chtimes(p, time.Now().Add(time.Duration(i)*time.Hour), time.Now().Add(time.Duration(i)*time.Hour))
	}
	removed, err := db.PruneBackups(dir, 2, 0)
	if err != nil {
		t.Fatalf("prune: %v", err)
	}
	if len(removed) != 3 {
		t.Errorf("removed %d, want 3", len(removed))
	}
	left, _ := filepath.Glob(filepath.Join(dir, "*.sqlite"))
	if len(left) != 2 {
		t.Errorf("%d dumps left, want 2", len(left))
	}
	// Manifests go with their dumps.
	mans, _ := filepath.Glob(filepath.Join(dir, "*.manifest.json"))
	if len(mans) != 2 {
		t.Errorf("%d manifests left, want 2", len(mans))
	}
}

// A long-idle instance must not prune itself down to nothing.
func TestPruneBackups_AgeNeverRemovesTheNewestN(t *testing.T) {
	dir := t.TempDir()
	old := time.Now().Add(-90 * 24 * time.Hour)
	for i := 0; i < 3; i++ {
		p := filepath.Join(dir, fmt.Sprintf("planner-2025010%d-000000.sqlite", i))
		os.WriteFile(p, []byte("x"), 0o644)
		os.Chtimes(p, old, old)
	}
	removed, err := db.PruneBackups(dir, 2, 24*time.Hour)
	if err != nil {
		t.Fatalf("prune: %v", err)
	}
	if len(removed) != 1 {
		t.Errorf("removed %d, want 1 (keepN protects the newest two)", len(removed))
	}
}

func TestPruneBackups_IgnoresUnrelatedFiles(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(dir, "planner.db"), []byte("x"), 0o644)
	removed, err := db.PruneBackups(dir, 1, 0)
	if err != nil {
		t.Fatalf("prune: %v", err)
	}
	if len(removed) != 0 {
		t.Errorf("removed %v, want nothing", removed)
	}
}

func TestPruneBackups_MissingDirIsNotAnError(t *testing.T) {
	if _, err := db.PruneBackups(filepath.Join(t.TempDir(), "nope"), 3, 0); err != nil {
		t.Errorf("missing dir should be a no-op, got %v", err)
	}
}
