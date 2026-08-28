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

// Two backups inside the same second must not overwrite each other. restore.sh
// takes a safety dump moments before restoring, and a collision there means the
// safety dump clobbers the dump being restored — turning the restore into a
// silent no-op.
func TestBackup_SameSecondDoesNotOverwrite(t *testing.T) {
	src, _ := seed(t, 4)
	dir := t.TempDir()

	first, err := db.BackupSQLite(src, dir, false)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	second, err := db.BackupSQLite(src, dir, false)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if first.Path == second.Path {
		t.Fatalf("both backups wrote to %s", first.Path)
	}
	for _, p := range []string{first.Path, second.Path} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("%s missing after the pair: %v", p, err)
		}
	}
}

// The guard restore.sh depends on before it overwrites a live database.
func TestVerifyDatabase(t *testing.T) {
	src, _ := seed(t, 2)
	if err := db.VerifyDatabase(src); err != nil {
		t.Errorf("valid database rejected: %v", err)
	}

	garbage := filepath.Join(t.TempDir(), "garbage.sqlite")
	os.WriteFile(garbage, []byte("this is not a database"), 0o644)
	if err := db.VerifyDatabase(garbage); err == nil {
		t.Error("garbage accepted as a planner database")
	}

	// An empty file SQLite will happily open, but which would wipe the planner.
	empty := filepath.Join(t.TempDir(), "empty.sqlite")
	os.WriteFile(empty, []byte{}, 0o644)
	if err := db.VerifyDatabase(empty); err == nil {
		t.Error("empty file accepted as a planner database")
	}

	if err := db.VerifyDatabase(filepath.Join(t.TempDir(), "nope.sqlite")); err == nil {
		t.Error("missing file accepted")
	}
}

// The round-trip the design calls non-optional: an untested restore is not a
// restore. Backup, mutate the source, restore the dump over it, and assert the
// data actually went back.
//
// This is the one test that would have caught the filename-collision bug, where
// a safety dump silently overwrote the dump being restored and the restore
// became a no-op that reported success.
func TestBackupRestore_RoundTrip(t *testing.T) {
	src, h := seed(t, 20)
	dir := t.TempDir()

	res, err := db.BackupSQLite(src, dir, true)
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	if res.RowCounts["users"] != 20 {
		t.Fatalf("backup captured %d users, want 20", res.RowCounts["users"])
	}

	// Mutate after the backup: add rows and delete some existing ones.
	for i := 0; i < 7; i++ {
		if _, err := h.Exec(`INSERT INTO users(username) VALUES (?)`, fmt.Sprintf("after%d", i)); err != nil {
			t.Fatalf("mutate: %v", err)
		}
	}
	if _, err := h.Exec(`DELETE FROM planners WHERE id <= 5`); err != nil {
		t.Fatalf("mutate: %v", err)
	}
	var mutatedUsers, mutatedPlanners int
	h.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&mutatedUsers)
	h.QueryRow(`SELECT COUNT(*) FROM planners`).Scan(&mutatedPlanners)
	if mutatedUsers != 27 || mutatedPlanners != 15 {
		t.Fatalf("setup wrong: users=%d planners=%d, want 27/15", mutatedUsers, mutatedPlanners)
	}

	// The dump must still verify before we would ever overwrite with it.
	if err := db.VerifyDatabase(res.Path); err != nil {
		t.Fatalf("dump failed verification: %v", err)
	}

	// Restore, the way scripts/restore.sh does: close, copy over, drop stale
	// WAL and shared-memory sidecars so SQLite starts clean.
	h.Close()
	data, err := os.ReadFile(res.Path)
	if err != nil {
		t.Fatalf("read dump: %v", err)
	}
	if err := os.WriteFile(src, data, 0o644); err != nil {
		t.Fatalf("restore: %v", err)
	}
	os.Remove(src + "-wal")
	os.Remove(src + "-shm")

	restored, err := sql.Open("sqlite", src)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer restored.Close()

	var users, planners, activities int
	restored.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&users)
	restored.QueryRow(`SELECT COUNT(*) FROM planners`).Scan(&planners)
	restored.QueryRow(`SELECT COUNT(*) FROM activities`).Scan(&activities)

	if users != 20 || planners != 20 || activities != 20 {
		t.Errorf("after restore users=%d planners=%d activities=%d, want 20/20/20", users, planners, activities)
	}
	// The mutations must be gone, not merely outnumbered.
	var leaked int
	restored.QueryRow(`SELECT COUNT(*) FROM users WHERE username LIKE 'after%'`).Scan(&leaked)
	if leaked != 0 {
		t.Errorf("%d post-backup rows survived the restore", leaked)
	}
}
