// Package middleware provides HTTP middleware for the planner server.
package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/golang-jwt/jwt/v5"
	"planner/internal/config"
	"planner/internal/db"
)

type contextKey int

const ctxUser contextKey = 0

// AuthUser is the decoded JWT payload attached to authenticated requests.
type AuthUser struct {
	ID      int    `json:"id"`
	Username string `json:"username"`
	Email   string `json:"email"`
	IsAdmin bool   `json:"is_admin"`
}

type plannerClaims struct {
	ID       int    `json:"id"`
	Username string `json:"username"`
	Email    string `json:"email"`
	jwt.RegisteredClaims
}

// RequireAuth wraps a handler with JWT authentication.
// On success it attaches the user to the request context via UserFrom.
// It performs a DB lookup to populate IsAdmin so demotion takes effect immediately.
func RequireAuth(cfg *config.Config, database *db.DB, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var tokenStr string
		if header := r.Header.Get("Authorization"); strings.HasPrefix(header, "Bearer ") {
			tokenStr = strings.TrimPrefix(header, "Bearer ")
		} else if c, err := r.Cookie("cp_token"); err == nil {
			tokenStr = c.Value
		} else {
			jsonError(w, http.StatusUnauthorized, "Authentication required")
			return
		}

		var claims plannerClaims
		_, err := jwt.ParseWithClaims(tokenStr, &claims, func(t *jwt.Token) (any, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, jwt.ErrSignatureInvalid
			}
			return []byte(cfg.JWTSecret), nil
		})
		if err != nil {
			jsonError(w, http.StatusUnauthorized, "Invalid or expired token")
			return
		}

		var isAdmin bool
		_ = database.QueryRowContext(r.Context(),
			database.Rebind("SELECT is_admin FROM users WHERE id = ?"), claims.ID,
		).Scan(&isAdmin)

		user := &AuthUser{ID: claims.ID, Username: claims.Username, Email: claims.Email, IsAdmin: isAdmin}
		next(w, r.WithContext(context.WithValue(r.Context(), ctxUser, user)))
	}
}

// RequireAdmin wraps a handler, requiring both valid auth and is_admin = true.
func RequireAdmin(cfg *config.Config, database *db.DB, next http.HandlerFunc) http.HandlerFunc {
	return RequireAuth(cfg, database, func(w http.ResponseWriter, r *http.Request) {
		if !UserFrom(r).IsAdmin {
			jsonError(w, http.StatusForbidden, "Admin access required")
			return
		}
		next(w, r)
	})
}

// UserFrom extracts the authenticated user from the request context.
// Returns nil if the request was not authenticated.
func UserFrom(r *http.Request) *AuthUser {
	u, _ := r.Context().Value(ctxUser).(*AuthUser)
	return u
}

// jsonError writes a JSON {"error":"..."} response.
func jsonError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`{"error":` + jsonString(msg) + `}`))
}

func jsonString(s string) string {
	// Minimal JSON string encoding (no special chars expected in error messages)
	var b strings.Builder
	b.WriteByte('"')
	for _, c := range s {
		switch c {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		default:
			b.WriteRune(c)
		}
	}
	b.WriteByte('"')
	return b.String()
}
