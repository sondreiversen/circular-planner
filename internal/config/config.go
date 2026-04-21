package config

import (
	"log"
	"os"
	"strconv"
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
	ForceHTTPS    bool
	DatabaseURL   string
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
		ForceHTTPS:    forceHTTPS,
		DatabaseURL:   dbURL,
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
