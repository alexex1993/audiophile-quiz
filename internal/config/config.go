// Package config loads application settings from environment variables.
package config

import (
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"slices"
	"strconv"
	"strings"
)

type Config struct {
	Addr        string // listen address, e.g. ":8080"
	BaseURL     string // public URL, used for the OAuth redirect
	DatabaseURL string
	DataDir     string // persistent storage for processed clips

	GoogleClientID     string
	GoogleClientSecret string

	AdminEmails map[string]bool

	AttemptsPerDay int // hidden from players
	ClipSeconds    int
	MaxUploadMB    int64
}

// RedirectURL is the OAuth callback that must be registered in Google Cloud Console.
func (c *Config) RedirectURL() string { return c.BaseURL + "/auth/google/callback" }

// SecureCookies is true when the site is served over HTTPS.
func (c *Config) SecureCookies() bool { return strings.HasPrefix(c.BaseURL, "https://") }

func (c *Config) IsAdmin(email string) bool { return c.AdminEmails[strings.ToLower(email)] }

// AdminEmailList returns the lowercased admin emails.
func (c *Config) AdminEmailList() []string { return slices.Collect(maps.Keys(c.AdminEmails)) }

func Load() (*Config, error) {
	c := &Config{
		Addr:               env("ADDR", ":8080"),
		BaseURL:            strings.TrimRight(env("BASE_URL", "http://localhost:8080"), "/"),
		DatabaseURL:        os.Getenv("DATABASE_URL"),
		DataDir:            env("DATA_DIR", "/data"),
		GoogleClientID:     os.Getenv("GOOGLE_CLIENT_ID"),
		GoogleClientSecret: os.Getenv("GOOGLE_CLIENT_SECRET"),
		AdminEmails:        map[string]bool{},
		AttemptsPerDay:     envInt("ATTEMPTS_PER_DAY", 10),
		ClipSeconds:        envInt("CLIP_SECONDS", 30),
		MaxUploadMB:        int64(envInt("MAX_UPLOAD_MB", 1024)),
	}

	// The client JSON downloaded from Google Cloud Console can be used instead of
	// (or in addition to) the GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET variables.
	if path := os.Getenv("GOOGLE_CREDENTIALS_FILE"); path != "" {
		id, secret, err := readGoogleCredentials(path)
		if err != nil {
			return nil, err
		}
		if c.GoogleClientID == "" {
			c.GoogleClientID = id
		}
		if c.GoogleClientSecret == "" {
			c.GoogleClientSecret = secret
		}
	}

	for e := range strings.SplitSeq(os.Getenv("ADMIN_EMAILS"), ",") {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			c.AdminEmails[e] = true
		}
	}

	switch {
	case c.DatabaseURL == "":
		return nil, fmt.Errorf("DATABASE_URL is required")
	case c.GoogleClientID == "" || c.GoogleClientSecret == "":
		return nil, fmt.Errorf("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (or GOOGLE_CREDENTIALS_FILE) are required")
	case len(c.AdminEmails) == 0:
		return nil, fmt.Errorf("ADMIN_EMAILS is required: comma-separated Google emails allowed into /admin")
	}
	return c, nil
}

func readGoogleCredentials(path string) (id, secret string, err error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", "", fmt.Errorf("read google credentials: %w", err)
	}
	var f map[string]struct {
		ClientID     string `json:"client_id"`
		ClientSecret string `json:"client_secret"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		return "", "", fmt.Errorf("parse google credentials: %w", err)
	}
	for _, k := range []string{"web", "installed"} {
		if v, ok := f[k]; ok {
			return v.ClientID, v.ClientSecret, nil
		}
	}
	return "", "", fmt.Errorf("google credentials: no \"web\" section in %s", path)
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(key)); err == nil && v > 0 {
		return v
	}
	return def
}
