package config

import (
	"log"
	"os"
	"strconv"
	"strings"
)

type GitLab struct {
	Enabled     bool
	InstanceURL string
	ClientID    string
	ClientSecret string
	RedirectURI string
	Scopes      string
}

type Config struct {
	Port          int
	HTTPSPort     int
	TLSCertFile   string
	TLSKeyFile    string
	ForceHTTPS        bool
	TrustProxy        bool
	CookieSecure      string // "auto" (default), "true", or "false"
	AllowRegistration bool
	DatabaseURL       string
	JWTSecret     string
	NodeEnv       string
	DataDir       string
	AllowedOrigin string
	AppName       string
	AppLogoURL    string
	GitLab        GitLab
}

func Load() *Config {
	jwtSecret := env("JWT_SECRET", "")
	if len(jwtSecret) < 32 {
		log.Fatal("FATAL: JWT_SECRET must be set to a random string of at least 32 characters — generate one with: openssl rand -hex 32")
	}
	if isPlaceholderSecret(jwtSecret) {
		log.Fatal("FATAL: JWT_SECRET is set to a known placeholder or low-entropy value — generate a real random secret with: openssl rand -hex 32")
	}
	allowedOrigin := env("ALLOWED_ORIGIN", "http://localhost:3000")

	dataDir := env("DATA_DIR", "./data")
	dbURL := env("DATABASE_URL", "")
	if dbURL == "" {
		dbURL = "sqlite:" + dataDir + "/planner.db"
	}

	forceHTTPS := true
	if v := os.Getenv("FORCE_HTTPS"); v == "false" {
		forceHTTPS = false
	}
	trustProxy := os.Getenv("TRUST_PROXY") == "true"
	cookieSecure := strings.ToLower(strings.TrimSpace(env("COOKIE_SECURE", "auto")))
	if cookieSecure != "true" && cookieSecure != "false" {
		cookieSecure = "auto"
	}
	allowRegistration := os.Getenv("ALLOW_REGISTRATION") != "false"

	// GitLab SSO validation: when enabled all four vars are required.
	gitlabEnabled := os.Getenv("GITLAB_SSO_ENABLED") == "true"
	if gitlabEnabled {
		required := map[string]string{
			"GITLAB_INSTANCE_URL":   os.Getenv("GITLAB_INSTANCE_URL"),
			"GITLAB_CLIENT_ID":      os.Getenv("GITLAB_CLIENT_ID"),
			"GITLAB_CLIENT_SECRET":  os.Getenv("GITLAB_CLIENT_SECRET"),
			"GITLAB_REDIRECT_URI":   os.Getenv("GITLAB_REDIRECT_URI"),
		}
		for k, v := range required {
			if v == "" {
				log.Fatalf("GitLab SSO enabled but %s is not set — set it or disable GITLAB_SSO_ENABLED", k)
			}
		}
	}

	return &Config{
		Port:          envInt("PORT", 3000),
		HTTPSPort:     envInt("HTTPS_PORT", 3443),
		TLSCertFile:   env("TLS_CERT_FILE", ""),
		TLSKeyFile:    env("TLS_KEY_FILE", ""),
		ForceHTTPS:        forceHTTPS,
		TrustProxy:        trustProxy,
		CookieSecure:      cookieSecure,
		AllowRegistration: allowRegistration,
		DatabaseURL:       dbURL,
		JWTSecret:     jwtSecret,
		NodeEnv:       env("NODE_ENV", "development"),
		DataDir:       dataDir,
		AllowedOrigin: allowedOrigin,
		AppName:       env("APP_NAME", "Circular Planner"),
		AppLogoURL:    env("APP_LOGO_URL", ""),
		GitLab: GitLab{
			Enabled:      gitlabEnabled,
			InstanceURL:  env("GITLAB_INSTANCE_URL", ""),
			ClientID:     env("GITLAB_CLIENT_ID", ""),
			ClientSecret: env("GITLAB_CLIENT_SECRET", ""),
			RedirectURI:  env("GITLAB_REDIRECT_URI", ""),
			Scopes:       env("GITLAB_SCOPES", "read_user openid email"),
		},
	}
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

// placeholderSecrets are known example/placeholder values that must never be
// used as a real JWT_SECRET (e.g. copied verbatim from .env.example).
var placeholderSecrets = map[string]bool{
	"change-this-to-a-long-random-string": true,
	"your-secret-here":                    true,
	"your-secret-here-please-change":      true,
	"changeme":                            true,
	"change-me":                           true,
	"insecure-default-secret":             true,
	"replace-me-with-a-random-string":     true,
}

// isPlaceholderSecret rejects known placeholder strings (case-insensitive)
// and any secret made up of a single repeated character (e.g. "aaaa...").
func isPlaceholderSecret(s string) bool {
	trimmed := strings.ToLower(strings.TrimSpace(s))
	if placeholderSecrets[trimmed] {
		return true
	}
	if len(trimmed) == 0 {
		return false
	}
	first := trimmed[0]
	for i := 1; i < len(trimmed); i++ {
		if trimmed[i] != first {
			return false
		}
	}
	return true
}
