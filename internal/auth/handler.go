// Package auth implements /api/auth/* routes.
package auth

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
	"planner/internal/config"
	"planner/internal/db"
	"planner/internal/middleware"
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
	var body struct {
		Username string `json:"username"`
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := readJSON(r, &body); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	if body.Username == "" || body.Email == "" || body.Password == "" {
		jsonError(w, http.StatusBadRequest, "username, email and password are required")
		return
	}
	if len(body.Password) < 8 {
		jsonError(w, http.StatusBadRequest, "Password must be at least 8 characters")
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), 10)
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

	token, err := h.makeToken(id, username, email)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Token generation failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token": token,
		"user":  map[string]any{"id": id, "username": username, "email": email},
	})
}

// --- POST /api/auth/login ---

func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := readJSON(r, &body); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	if body.Email == "" || body.Password == "" {
		jsonError(w, http.StatusBadRequest, "email and password are required")
		return
	}

	var id int
	var username, email string
	var hashPtr *string
	err := h.db.QueryRowContext(r.Context(),
		h.db.Rebind("SELECT id, username, email, password_hash FROM users WHERE email = ?"),
		strings.ToLower(strings.TrimSpace(body.Email)),
	).Scan(&id, &username, &email, &hashPtr)

	if err != nil || hashPtr == nil || bcrypt.CompareHashAndPassword([]byte(*hashPtr), []byte(body.Password)) != nil {
		jsonError(w, http.StatusUnauthorized, "Invalid email or password")
		return
	}

	token, err := h.makeToken(id, username, email)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Login failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token": token,
		"user":  map[string]any{"id": id, "username": username, "email": email},
	})
}

// --- GET /api/auth/me ---

func (h *Handler) Me(w http.ResponseWriter, r *http.Request) {
	u := middleware.UserFrom(r)
	writeJSON(w, http.StatusOK, map[string]any{"user": u})
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
		Secure:   h.cfg.TLSCertFile != "",
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
	http.SetCookie(w, &http.Cookie{Name: "cp_oauth_state", MaxAge: -1, Path: "/"})

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

	// Return a tiny page that stores the token and redirects
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store, no-cache")
	fmt.Fprintf(w, `<!DOCTYPE html>
<html><head><title>Signing in…</title></head><body>
<script>
try { localStorage.setItem('cp_token', %s); } catch(e) {}
location.replace('/dashboard.html');
</script>
<noscript>JavaScript is required to complete sign-in.</noscript>
</body></html>`, jsonQuote(jwtToken))
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
		// Known user — update email/username
		err = h.db.QueryRowContext(ctx,
			h.db.Rebind(`UPDATE users SET gitlab_username = ?, email = ? WHERE gitlab_id = ? RETURNING id, username, email`),
			u.Username, u.Email, u.ID,
		).Scan(&id, &username, &email)
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
		h.db.Rebind(`INSERT INTO users(username, email, gitlab_id, gitlab_username, auth_provider)
		             VALUES (?, ?, ?, ?, 'gitlab')
		             RETURNING id, username, email`),
		uname, u.Email, u.ID, u.Username,
	).Scan(&id, &username, &email)
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

// --- misc helpers ---

func isDuplicateError(err error) bool {
	s := err.Error()
	return strings.Contains(s, "UNIQUE constraint failed") || // SQLite
		strings.Contains(s, "duplicate key") || // Postgres
		strings.Contains(s, "23505") // Postgres error code
}

func jsonQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
