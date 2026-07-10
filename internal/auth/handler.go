// Package auth implements /api/auth/* routes.
package auth

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/mail"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
	"planner/internal/config"
	"planner/internal/db"
	"planner/internal/middleware"
	"planner/internal/settings"
)

// Handler handles /api/auth/* requests.
type Handler struct {
	db  *db.DB
	cfg *config.Config
}

func NewHandler(database *db.DB, cfg *config.Config) *Handler {
	return &Handler{db: database, cfg: cfg}
}

// --- helpers ---

// usernameRe restricts usernames to a small, predictable charset.
var usernameRe = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)

// dummyBcryptHash is compared against on every failed login lookup (unknown
// user or missing password hash) so that response timing doesn't reveal
// whether a given username/email exists — both paths cost one bcrypt compare.
var dummyBcryptHash = mustDummyHash()

func mustDummyHash() []byte {
	h, err := bcrypt.GenerateFromPassword([]byte("dummy-password-for-timing-equalisation"), 12)
	if err != nil {
		panic(err)
	}
	return h
}

type claims struct {
	ID       int    `json:"id"`
	Username string `json:"username"`
	Email    string `json:"email"`
	jwt.RegisteredClaims
}

func (h *Handler) makeToken(id int, username, email string) (string, error) {
	c := claims{
		ID:       id,
		Username: username,
		Email:    email,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(7 * 24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString([]byte(h.cfg.JWTSecret))
}

// cookieSecure reports whether the Secure attribute should be set on
// cookies we issue. Controlled by COOKIE_SECURE ("auto"|"true"|"false");
// "auto" (the default) preserves the historical heuristic of TLS being
// configured directly or a trusted reverse proxy terminating TLS for us.
func (h *Handler) cookieSecure() bool {
	switch h.cfg.CookieSecure {
	case "true":
		return true
	case "false":
		return false
	default:
		return h.cfg.TLSCertFile != "" || h.cfg.TrustProxy
	}
}

// setSessionCookie writes the cp_token HttpOnly session cookie (7-day TTL).
func (h *Handler) setSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     "cp_token",
		Value:    token,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.cookieSecure(),
		Path:     "/",
		MaxAge:   7 * 24 * 60 * 60,
	})
}

// clearSessionCookie removes the cp_token cookie.
func (h *Handler) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     "cp_token",
		Value:    "",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.cookieSecure(),
		Path:     "/",
		MaxAge:   -1,
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func readJSON(r *http.Request, v any) error {
	return json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v)
}

func jsonError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// --- POST /api/auth/register ---

func (h *Handler) Register(w http.ResponseWriter, r *http.Request) {
	if !settings.GetBool(r.Context(), h.db, "allow_registration", h.cfg.AllowRegistration) {
		jsonError(w, http.StatusForbidden, "Registration is disabled")
		return
	}
	var body struct {
		Username string `json:"username"`
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := readJSON(r, &body); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	body.Username = strings.TrimSpace(body.Username)
	body.Email = strings.TrimSpace(body.Email)
	if body.Username == "" || body.Email == "" || body.Password == "" {
		jsonError(w, http.StatusBadRequest, "username, email and password are required")
		return
	}
	if len(body.Username) < 3 || len(body.Username) > 32 || !usernameRe.MatchString(body.Username) {
		jsonError(w, http.StatusBadRequest, "Username must be 3-32 characters and contain only letters, numbers, dots, underscores, or hyphens")
		return
	}
	if len(body.Email) > 254 {
		jsonError(w, http.StatusBadRequest, "Email is too long")
		return
	}
	addr, err := mail.ParseAddress(body.Email)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid email address")
		return
	}
	body.Email = addr.Address
	if len(body.Password) < 8 {
		jsonError(w, http.StatusBadRequest, "Password must be at least 8 characters")
		return
	}
	if len([]byte(body.Password)) > 72 {
		jsonError(w, http.StatusBadRequest, "Password must be at most 72 bytes")
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), 12)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Registration failed")
		return
	}

	var id int
	var username, email string
	err = h.db.QueryRowContext(r.Context(),
		h.db.Rebind(`INSERT INTO users(username, email, password_hash)
		             VALUES (?, ?, ?) RETURNING id, username, email`),
		strings.TrimSpace(body.Username),
		strings.ToLower(strings.TrimSpace(body.Email)),
		string(hash),
	).Scan(&id, &username, &email)

	if err != nil {
		if isDuplicateError(err) {
			jsonError(w, http.StatusConflict, "Username or email already in use")
			return
		}
		jsonError(w, http.StatusInternalServerError, "Registration failed")
		return
	}

	if err := claimPendingTags(r.Context(), h.db, id, username); err != nil {
		log.Printf("claim pending tags: %v", err)
	}

	token, err := h.makeToken(id, username, email)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Token generation failed")
		return
	}
	h.setSessionCookie(w, token)
	writeJSON(w, http.StatusOK, map[string]any{
		"token": token,
		"user":  map[string]any{"id": id, "username": username, "email": email},
	})
}

// --- POST /api/auth/login ---

func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	// Gate: if password login is disabled, reject immediately (before any body parsing).
	if !settings.GetBool(r.Context(), h.db, "allow_password_login", true) {
		jsonError(w, http.StatusForbidden, "Password login is disabled. Please use SSO.")
		return
	}

	var body struct {
		Identifier string `json:"identifier"` // username or email
		Email      string `json:"email"`       // legacy alias — accepted for compatibility
		Password   string `json:"password"`
	}
	if err := readJSON(r, &body); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	// Accept either the new "identifier" field or the legacy "email" field.
	identifier := strings.TrimSpace(body.Identifier)
	if identifier == "" {
		identifier = strings.TrimSpace(body.Email)
	}
	if identifier == "" || body.Password == "" {
		jsonError(w, http.StatusBadRequest, "identifier and password are required")
		return
	}

	// Normalise: if it looks like an email, lowercase it.
	normalised := identifier
	if strings.Contains(identifier, "@") {
		normalised = strings.ToLower(identifier)
	}

	var id int
	var username, email string
	var hashPtr *string
	err := h.db.QueryRowContext(r.Context(),
		h.db.Rebind("SELECT id, username, email, password_hash FROM users WHERE email = ? OR username = ?"),
		strings.ToLower(normalised), normalised,
	).Scan(&id, &username, &email, &hashPtr)

	if err != nil || hashPtr == nil {
		// No such user (or SSO-only account with no password hash): still run a
		// bcrypt comparison against a dummy hash so the response time doesn't
		// disclose whether the account exists.
		bcrypt.CompareHashAndPassword(dummyBcryptHash, []byte(body.Password))
		jsonError(w, http.StatusUnauthorized, "Invalid credentials")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(*hashPtr), []byte(body.Password)) != nil {
		jsonError(w, http.StatusUnauthorized, "Invalid credentials")
		return
	}

	token, err := h.makeToken(id, username, email)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Login failed")
		return
	}
	h.setSessionCookie(w, token)
	writeJSON(w, http.StatusOK, map[string]any{
		"token": token,
		"user":  map[string]any{"id": id, "username": username, "email": email},
	})
}

// --- POST /api/auth/logout ---

func (h *Handler) Logout(w http.ResponseWriter, r *http.Request) {
	h.clearSessionCookie(w)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// --- GET /api/auth/me ---

func (h *Handler) Me(w http.ResponseWriter, r *http.Request) {
	u := middleware.UserFrom(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"user": map[string]any{
			"id":        u.ID,
			"username":  u.Username,
			"email":     u.Email,
			"fullName":  u.FullName,
			"is_admin":  u.IsAdmin,
		},
	})
}

// --- GET /api/auth/gitlab/status ---

func (h *Handler) GitLabStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"enabled": h.cfg.GitLab.Enabled})
}

// --- GET /api/auth/gitlab/authorize ---

func (h *Handler) GitLabAuthorize(w http.ResponseWriter, r *http.Request) {
	if !h.cfg.GitLab.Enabled {
		jsonError(w, http.StatusServiceUnavailable, "GitLab SSO is not enabled")
		return
	}

	state, err := randomHex(16)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Failed to generate state")
		return
	}

	// Store state in a signed HttpOnly cookie (10 min TTL)
	sig := signCookie(state, h.cfg.JWTSecret)
	cookieVal := state + "." + sig
	http.SetCookie(w, &http.Cookie{
		Name:     "cp_oauth_state",
		Value:    cookieVal,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   600,
		Secure:   h.cookieSecure(),
		Path:     "/",
	})

	params := url.Values{
		"client_id":     {h.cfg.GitLab.ClientID},
		"redirect_uri":  {h.cfg.GitLab.RedirectURI},
		"response_type": {"code"},
		"scope":         {h.cfg.GitLab.Scopes},
		"state":         {state},
	}
	http.Redirect(w, r, h.cfg.GitLab.InstanceURL+"/oauth/authorize?"+params.Encode(), http.StatusFound)
}

// --- GET /api/auth/gitlab/callback ---

func (h *Handler) GitLabCallback(w http.ResponseWriter, r *http.Request) {
	if !h.cfg.GitLab.Enabled {
		http.Error(w, "GitLab SSO is not enabled", http.StatusServiceUnavailable)
		return
	}

	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")

	// Read and clear state cookie
	var storedState string
	if c, err := r.Cookie("cp_oauth_state"); err == nil {
		parts := strings.SplitN(c.Value, ".", 2)
		if len(parts) == 2 {
			expectedSig := signCookie(parts[0], h.cfg.JWTSecret)
			if hmac.Equal([]byte(parts[1]), []byte(expectedSig)) {
				storedState = parts[0]
			}
		}
	}
	http.SetCookie(w, &http.Cookie{Name: "cp_oauth_state", MaxAge: -1, Path: "/", Secure: h.cookieSecure(), HttpOnly: true, SameSite: http.SameSiteLaxMode})

	if code == "" || state == "" || state != storedState {
		http.Error(w, "Invalid OAuth state. Please try signing in again.", http.StatusBadRequest)
		return
	}

	// Exchange code for access token
	tokenData, err := gitlabTokenExchange(h.cfg, code)
	if err != nil {
		http.Error(w, "Failed to exchange GitLab token. Please try again.", http.StatusBadGateway)
		return
	}

	// Fetch GitLab user profile
	gitlabUser, err := gitlabFetchUser(h.cfg, tokenData.AccessToken)
	if err != nil {
		http.Error(w, "Failed to fetch GitLab user profile. Please try again.", http.StatusBadGateway)
		return
	}

	// Upsert user
	userID, username, email, err := h.upsertGitLabUser(r, gitlabUser)
	if err != nil {
		http.Error(w, "Failed to create or find user account.", http.StatusInternalServerError)
		return
	}

	jwtToken, err := h.makeToken(userID, username, email)
	if err != nil {
		http.Error(w, "Token generation failed.", http.StatusInternalServerError)
		return
	}

	h.setSessionCookie(w, jwtToken)
	http.Redirect(w, r, "/dashboard.html", http.StatusFound)
}

// upsertGitLabUser finds or creates a user record for a GitLab OAuth login.
func (h *Handler) upsertGitLabUser(r *http.Request, u *gitlabProfile) (id int, username, email string, err error) {
	ctx := r.Context()

	// Check if gitlab_id already exists
	err = h.db.QueryRowContext(ctx,
		h.db.Rebind("SELECT id, username, email FROM users WHERE gitlab_id = ?"),
		u.ID,
	).Scan(&id, &username, &email)
	if err == nil {
		// Known user — always keep gitlab_username/full_name in sync. Only touch
		// email when the GitLab profile's email actually differs from what we
		// have stored, and never let an email collision fail the login: if
		// another account already owns that email, log a warning and keep the
		// existing stored email instead of erroring out (UNIQUE constraint).
		if u.Email != "" && !strings.EqualFold(u.Email, email) {
			if _, updErr := h.db.ExecContext(ctx,
				h.db.Rebind("UPDATE users SET email = ? WHERE gitlab_id = ?"),
				u.Email, u.ID,
			); updErr != nil {
				if isDuplicateError(updErr) {
					log.Printf("gitlab sso: email %q for gitlab_id=%d collides with an existing account; keeping stored email", u.Email, u.ID)
				} else {
					log.Printf("gitlab sso: failed to update email for gitlab_id=%d: %v", u.ID, updErr)
				}
			} else {
				email = u.Email
			}
		}

		if _, updErr := h.db.ExecContext(ctx,
			h.db.Rebind("UPDATE users SET gitlab_username = ?, full_name = ? WHERE gitlab_id = ?"),
			u.Username, u.Name, u.ID,
		); updErr != nil {
			err = updErr
			return
		}
		err = nil
		return
	}

	// Refuse to link an existing account by email — prevents takeover via a GitLab
	// account that shares the email of a local user.
	var existingID int
	emailErr := h.db.QueryRowContext(ctx,
		h.db.Rebind("SELECT id FROM users WHERE email = ?"), u.Email,
	).Scan(&existingID)
	if emailErr == nil {
		err = fmt.Errorf("email already registered; log in with your password first to link GitLab")
		return
	}

	// New user — ensure unique username; use globally-unique gitlab_id as suffix on collision
	uname := u.Username
	var count int
	_ = h.db.QueryRowContext(ctx,
		h.db.Rebind("SELECT COUNT(*) FROM users WHERE username = ?"), uname,
	).Scan(&count)
	if count > 0 {
		uname = fmt.Sprintf("%s-%d", uname, u.ID)
	}

	err = h.db.QueryRowContext(ctx,
		h.db.Rebind(`INSERT INTO users(username, email, gitlab_id, gitlab_username, auth_provider, full_name)
		             VALUES (?, ?, ?, ?, 'gitlab', ?)
		             RETURNING id, username, email`),
		uname, u.Email, u.ID, u.Username, u.Name,
	).Scan(&id, &username, &email)
	if err == nil {
		if claimErr := claimPendingTags(ctx, h.db, id, username); claimErr != nil {
			log.Printf("claim pending tags: %v", claimErr)
		}
	}
	return
}

// --- GitLab HTTP helpers ---

type gitlabTokenResponse struct {
	AccessToken string `json:"access_token"`
}

type gitlabProfile struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	Email    string `json:"email"`
	Name     string `json:"name"`
}

var gitlabHTTPClient = &http.Client{Timeout: 10 * time.Second}

func gitlabTokenExchange(cfg *config.Config, code string) (*gitlabTokenResponse, error) {
	body, _ := json.Marshal(map[string]string{
		"client_id":     cfg.GitLab.ClientID,
		"client_secret": cfg.GitLab.ClientSecret,
		"code":          code,
		"grant_type":    "authorization_code",
		"redirect_uri":  cfg.GitLab.RedirectURI,
	})
	resp, err := gitlabHTTPClient.Post(cfg.GitLab.InstanceURL+"/oauth/token", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("gitlab token exchange: %s", resp.Status)
	}
	var t gitlabTokenResponse
	return &t, json.NewDecoder(resp.Body).Decode(&t)
}

func gitlabFetchUser(cfg *config.Config, accessToken string) (*gitlabProfile, error) {
	req, _ := http.NewRequest("GET", cfg.GitLab.InstanceURL+"/api/v4/user", nil)
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := gitlabHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("gitlab user fetch: %s", resp.Status)
	}
	var u gitlabProfile
	return &u, json.NewDecoder(resp.Body).Decode(&u)
}

// --- Cookie signing helpers ---

func signCookie(value, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(value))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", b), nil
}

// --- GET /api/users ---

// SearchUsers handles GET /api/users?q=<query>[&includeSelf=1].
// Returns up to 20 users whose username, email, or full name contains the query string.
// The current user is excluded from results unless includeSelf=1 is passed.
func (h *Handler) SearchUsers(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) < 2 {
		writeJSON(w, http.StatusOK, []any{})
		return
	}

	currentUserID := middleware.UserFrom(r).ID
	lowerQ := strings.ToLower(q)
	likePattern := "%" + escapeLike(lowerQ) + "%"
	includeSelf := r.URL.Query().Get("includeSelf") == "1"

	// Build WHERE clause: optionally exclude self.
	// SQLite uses LIKE (case-insensitive for ASCII by default);
	// Postgres uses ILIKE. Use LOWER() for portability.
	// Username/full name match by substring; email matches only by exact
	// case-insensitive equality (a substring match on email lets any
	// authenticated user enumerate other users' addresses).
	where := "(LOWER(username) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(full_name,'')) LIKE ? ESCAPE '\\' OR LOWER(email) = ?)"
	args := []any{likePattern, likePattern, lowerQ}
	if !includeSelf {
		where = "id != ? AND " + where
		args = append([]any{currentUserID}, args...)
	}

	q2 := `SELECT id, username, email, COALESCE(full_name,'') AS full_name
		FROM users WHERE ` + where + `
		ORDER BY COALESCE(NULLIF(full_name,''), username) LIMIT 20`
	rows, err := h.db.QueryContext(r.Context(), h.db.Rebind(q2), args...)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	defer rows.Close()

	type userResult struct {
		ID       int    `json:"id"`
		Username string `json:"username"`
		Email    string `json:"email"`
		FullName string `json:"fullName,omitempty"`
	}
	var results []userResult
	for rows.Next() {
		var u userResult
		var email string
		if err := rows.Scan(&u.ID, &u.Username, &email, &u.FullName); err != nil {
			continue
		}
		// Only surface the email when it's the exact match the caller searched
		// for — never as a side effect of a username/full-name substring hit.
		if strings.EqualFold(email, q) {
			u.Email = email
		}
		results = append(results, u)
	}
	if results == nil {
		results = []userResult{}
	}
	writeJSON(w, http.StatusOK, results)
}

// escapeLike escapes LIKE metacharacters (\, %, _) so user-supplied search
// text is matched literally rather than as a wildcard pattern. Pair with
// "ESCAPE '\\'" in the SQL.
func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

// --- GET /api/auth/registration-status ---

// RegistrationStatus returns whether self-registration is currently enabled.
// This endpoint is public (no auth required) so the login page can show/hide
// the registration form before the user has a token.
func (h *Handler) RegistrationStatus(w http.ResponseWriter, r *http.Request) {
	enabled := settings.GetBool(r.Context(), h.db, "allow_registration", h.cfg.AllowRegistration)
	writeJSON(w, http.StatusOK, map[string]bool{"enabled": enabled})
}

// claimPendingTags moves any activity_pending_tags for username into activity_user_tags.
// Called after a new user is created. Errors are logged but do not fail registration.
func claimPendingTags(ctx context.Context, database *db.DB, userID int, username string) error {
	_, err := database.ExecContext(ctx, database.Rebind(`
		INSERT INTO activity_user_tags(activity_id, planner_id, user_id)
		SELECT DISTINCT pt.activity_id, pt.planner_id, ?
		FROM activity_pending_tags pt
		WHERE LOWER(pt.username) = LOWER(?)
		ON CONFLICT (activity_id, planner_id, user_id) DO NOTHING
	`), userID, username)
	if err != nil {
		return err
	}
	_, err = database.ExecContext(ctx, database.Rebind(
		"DELETE FROM activity_pending_tags WHERE LOWER(username) = LOWER(?)"), username)
	return err
}

// --- misc helpers ---

func isDuplicateError(err error) bool {
	s := err.Error()
	return strings.Contains(s, "UNIQUE constraint failed") || // SQLite
		strings.Contains(s, "duplicate key") || // Postgres
		strings.Contains(s, "23505") // Postgres error code
}

