package db

import "testing"

func TestRebind(t *testing.T) {
	tests := []struct {
		name    string
		dialect Dialect
		in      string
		want    string
	}{
		{"sqlite passthrough", SQLite, "SELECT * FROM u WHERE id = ? AND x = ?", "SELECT * FROM u WHERE id = ? AND x = ?"},
		{"postgres rebinds", Postgres, "SELECT * FROM u WHERE id = ? AND x = ?", "SELECT * FROM u WHERE id = $1 AND x = $2"},
		{"postgres no placeholders", Postgres, "SELECT 1", "SELECT 1"},
		{"postgres many", Postgres, "? ? ? ?", "$1 $2 $3 $4"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d := &DB{Dialect: tt.dialect}
			if got := d.Rebind(tt.in); got != tt.want {
				t.Errorf("Rebind(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}
