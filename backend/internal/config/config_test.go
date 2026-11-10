package config

import (
	"strings"
	"testing"
)

// clearEnv blanks every variable Load reads so a developer's .env cannot affect the test.
// (godotenv never overrides variables that are already set, even to "".)
func clearEnv(t *testing.T) {
	for _, k := range []string{
		"APP_ENV", "PORT", "DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME", "DB_SSLMODE",
		"JWT_SECRET", "UPLOAD_DIR", "FRONTEND_URL", "TRUSTED_PROXIES", "ENABLE_SWAGGER",
		"DEV_ADMIN_USERNAME", "DEV_ADMIN_PASSWORD",
	} {
		t.Setenv(k, "")
	}
}

const strongSecret = "k8Jd93hF0aQz7LmN2pXv5RtY1uWc4sBe"

func TestLoad_ProductionIsDefaultAndFailsClosed(t *testing.T) {
	clearEnv(t)
	_, err := Load()
	if err == nil {
		t.Fatal("expected production config without secrets to fail")
	}
	for _, want := range []string{"APP_ENV=production", "JWT_SECRET is required", "DB_PASSWORD is required", "FRONTEND_URL is required"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
}

func TestLoad_RejectsPlaceholdersAndShortSecrets(t *testing.T) {
	clearEnv(t)
	t.Setenv("FRONTEND_URL", "https://comcamp.example")
	t.Setenv("DB_PASSWORD", "change_this_strong_password")
	t.Setenv("JWT_SECRET", "change_this_to_min_32_chars_secret")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "placeholder") {
		t.Fatalf("expected placeholder rejection, got %v", err)
	}

	t.Setenv("JWT_SECRET", "too-short")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "at least 32") {
		t.Fatalf("expected short secret rejection, got %v", err)
	}
}

func TestLoad_ProductionValid(t *testing.T) {
	clearEnv(t)
	t.Setenv("FRONTEND_URL", "https://comcamp.example/, https://www.comcamp.example")
	t.Setenv("DB_PASSWORD", "a-real-password")
	t.Setenv("JWT_SECRET", strongSecret)
	t.Setenv("TRUSTED_PROXIES", "127.0.0.1, 10.0.0.0/8")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.EnableSwagger {
		t.Error("swagger must be off in production by default")
	}
	if len(cfg.AllowedOrigins) != 2 || cfg.AllowedOrigins[0] != "https://comcamp.example" {
		t.Errorf("unexpected origins (localhost must not be allowed in production): %v", cfg.AllowedOrigins)
	}
	if len(cfg.TrustedProxies) != 2 {
		t.Errorf("unexpected trusted proxies: %v", cfg.TrustedProxies)
	}
}

func TestLoad_ProductionRejectsDevAdmin(t *testing.T) {
	clearEnv(t)
	t.Setenv("FRONTEND_URL", "https://comcamp.example")
	t.Setenv("DB_PASSWORD", "a-real-password")
	t.Setenv("JWT_SECRET", strongSecret)
	t.Setenv("DEV_ADMIN_PASSWORD", "whatever")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "DEV_ADMIN_PASSWORD") {
		t.Fatalf("expected DEV_ADMIN_PASSWORD rejection, got %v", err)
	}
}

func TestLoad_DevelopmentGeneratesRandomSecret(t *testing.T) {
	clearEnv(t)
	t.Setenv("APP_ENV", "development")

	a, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	b, _ := Load()
	if len(a.JWTSecret) < MinJWTSecretLen || a.JWTSecret == b.JWTSecret {
		t.Fatalf("expected a fresh random dev secret per process, got %q / %q", a.JWTSecret, b.JWTSecret)
	}
	if !a.EnableSwagger {
		t.Error("swagger should be on in development")
	}
}
