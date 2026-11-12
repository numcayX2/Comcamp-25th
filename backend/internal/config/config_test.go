package config_test

import (
	"os"
	"strings"
	"testing"

	"comcamp25-backend/internal/config"
)

func clearConfigEnv(t *testing.T) {
	t.Helper()
	keys := []string{
		"APP_ENV",
		"PORT",
		"DB_HOST",
		"DB_PORT",
		"DB_USER",
		"DB_PASSWORD",
		"DB_NAME",
		"DB_SSLMODE",
		"JWT_SECRET",
		"UPLOAD_DIR",
		"FRONTEND_URL",
		"CORS_ALLOWED_ORIGINS",
		"TRUSTED_PROXIES",
		"TRUSTED_PROXY",
		"ALLOW_MEMORY_FALLBACK",
		"ADMIN_USERNAME",
		"ADMIN_PASSWORD",
		"ENABLE_SWAGGER",
	}
	for _, k := range keys {
		t.Setenv(k, "")
		_ = os.Unsetenv(k)
	}
}

func TestConfig_DevelopmentEphemeralSecretAndDefaults(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("APP_ENV", "development")

	cfg1 := config.Load()
	cfg2 := config.Load()

	if !cfg1.IsDevelopment() || cfg1.IsProduction() {
		t.Fatalf("expected development mode, got AppEnv=%q", cfg1.AppEnv)
	}
	if len(cfg1.JWTSecret) < 32 {
		t.Fatalf("expected generated dev JWT_SECRET >= 32 bytes, got %d", len(cfg1.JWTSecret))
	}
	if cfg1.JWTSecret == cfg2.JWTSecret {
		t.Errorf("expected two development loads without JWT_SECRET to generate distinct ephemeral secrets")
	}
	if !cfg1.AllowMemoryFallback {
		t.Errorf("expected AllowMemoryFallback=true in development by default")
	}
	if !cfg1.EnableSwagger {
		t.Errorf("expected EnableSwagger=true in development by default")
	}
	if err := cfg1.Validate(); err != nil {
		t.Fatalf("expected default dev config to validate, got %v", err)
	}
	if !strings.Contains(cfg1.DSN(), "host=127.0.0.1") || !strings.Contains(cfg1.DSN(), "dbname=comcamp_db") {
		t.Errorf("unexpected DSN: %s", cfg1.DSN())
	}
}

func TestConfig_ProductionValidation(t *testing.T) {
	validProdEnv := func(t *testing.T) {
		t.Helper()
		clearConfigEnv(t)
		t.Setenv("APP_ENV", "production")
		t.Setenv("JWT_SECRET", "0123456789abcdef0123456789abcdef0123456789abcdef")
		t.Setenv("DB_PASSWORD", "Pr0d!Str0ngP@ssw0rd_9988")
		t.Setenv("CORS_ALLOWED_ORIGINS", "https://comcamp.csmju.com")
		t.Setenv("ADMIN_PASSWORD", "Adm1n!Str0ngP@ssword_25")
		t.Setenv("TRUSTED_PROXIES", "127.0.0.1,10.0.0.0/8")
	}

	t.Run("valid production config passes", func(t *testing.T) {
		validProdEnv(t)
		cfg := config.Load()
		if !cfg.IsProduction() || cfg.IsDevelopment() {
			t.Fatalf("expected production mode, got %q", cfg.AppEnv)
		}
		if cfg.AllowMemoryFallback {
			t.Errorf("expected AllowMemoryFallback=false by default in production")
		}
		if cfg.EnableSwagger {
			t.Errorf("expected EnableSwagger=false by default in production")
		}
		if err := cfg.Validate(); err != nil {
			t.Fatalf("expected valid production config, got %v", err)
		}
	})

	cases := []struct {
		name string
		set  func(t *testing.T)
	}{
		{
			name: "missing JWT_SECRET in production",
			set: func(t *testing.T) {
				t.Setenv("JWT_SECRET", "")
				_ = os.Unsetenv("JWT_SECRET")
			},
		},
		{
			name: "short JWT_SECRET in production",
			set: func(t *testing.T) {
				t.Setenv("JWT_SECRET", "too-short")
			},
		},
		{
			name: "placeholder JWT_SECRET in production",
			set: func(t *testing.T) {
				t.Setenv("JWT_SECRET", "change_this_to_min_32_chars_secret")
			},
		},
		{
			name: "another placeholder JWT_SECRET prefix",
			set: func(t *testing.T) {
				t.Setenv("JWT_SECRET", "change_this_anything_at_all_32_bytes_min")
			},
		},
		{
			name: "default DB_PASSWORD in production",
			set: func(t *testing.T) {
				t.Setenv("DB_PASSWORD", "change_this_strong_password")
			},
		},
		{
			name: "empty DB_PASSWORD in production",
			set: func(t *testing.T) {
				t.Setenv("DB_PASSWORD", "   ")
			},
		},
		{
			name: "ALLOW_MEMORY_FALLBACK=true in production",
			set: func(t *testing.T) {
				t.Setenv("ALLOW_MEMORY_FALLBACK", "true")
			},
		},
		{
			name: "wildcard CORS origin in production",
			set: func(t *testing.T) {
				t.Setenv("CORS_ALLOWED_ORIGINS", "https://comcamp.csmju.com,*")
			},
		},
		{
			name: "weak ADMIN_PASSWORD (<12 chars) in production",
			set: func(t *testing.T) {
				t.Setenv("ADMIN_PASSWORD", "shortpass")
			},
		},
		{
			name: "placeholder ADMIN_PASSWORD in production",
			set: func(t *testing.T) {
				t.Setenv("ADMIN_PASSWORD", "change_this_admin_password")
			},
		},
		{
			name: "invalid PORT",
			set: func(t *testing.T) {
				t.Setenv("PORT", "99999")
			},
		},
		{
			name: "invalid TRUSTED_PROXIES",
			set: func(t *testing.T) {
				t.Setenv("TRUSTED_PROXIES", "not-an-ip-or-cidr")
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			validProdEnv(t)
			tc.set(t)
			cfg := config.Load()
			if err := cfg.Validate(); err == nil {
				t.Fatalf("expected Validate() error for %s, got nil", tc.name)
			}
		})
	}
}

func TestConfig_DevRejectsShortExplicitSecret(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("APP_ENV", "dev")
	t.Setenv("JWT_SECRET", "short-secret")

	cfg := config.Load()
	if err := cfg.Validate(); err == nil {
		t.Fatalf("expected error for explicit short JWT_SECRET in dev")
	}
}
