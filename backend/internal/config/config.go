package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
)

const (
	defaultPlaceholderJWTSecret  = "change_this_to_min_32_chars_secret"
	defaultPlaceholderDBPassword = "change_this_strong_password"
)

var defaultDevCORSOrigins = []string{
	"http://localhost:4321",
	"http://127.0.0.1:4321",
	"http://localhost:3000",
}

type Config struct {
	AppEnv              string
	Port                string
	DBHost              string
	DBPort              string
	DBUser              string
	DBPassword          string
	DBName              string
	DBSSLMode           string
	JWTSecret           string
	UploadDir           string
	FrontendURL         string
	CORSAllowedOrigins  []string
	TrustedProxies      []string
	AllowMemoryFallback bool
	AdminSeedUsername   string
	AdminSeedPassword   string
	EnableSwagger       bool
}

func Load() *Config {
	// Try loading from .env in backend directory or parent directory
	_ = godotenv.Load()
	_ = godotenv.Load("../.env")

	appEnv := strings.ToLower(strings.TrimSpace(getEnv("APP_ENV", "development")))
	isProd := appEnv == "production" || appEnv == "prod"

	defaultFrontendURL := "http://localhost:4321"
	if isProd {
		defaultFrontendURL = ""
	}
	frontendURL := strings.TrimSpace(getEnv("FRONTEND_URL", defaultFrontendURL))

	jwtSecret := strings.TrimSpace(os.Getenv("JWT_SECRET"))
	if jwtSecret == "" && !isProd {
		jwtSecret = generateRandomSecret(32)
	}

	corsRaw := strings.TrimSpace(os.Getenv("CORS_ALLOWED_ORIGINS"))
	corsOrigins := parseCORSOrigins(corsRaw, frontendURL, isProd)

	trustedProxyRaw := strings.TrimSpace(os.Getenv("TRUSTED_PROXIES"))
	if trustedProxyRaw == "" {
		trustedProxyRaw = strings.TrimSpace(os.Getenv("TRUSTED_PROXY"))
	}

	return &Config{
		AppEnv:              appEnv,
		Port:                getEnv("PORT", "8000"),
		DBHost:              getEnv("DB_HOST", "127.0.0.1"),
		DBPort:              getEnv("DB_PORT", "5432"),
		DBUser:              getEnv("DB_USER", "comcamp"),
		DBPassword:          getEnv("DB_PASSWORD", defaultPlaceholderDBPassword),
		DBName:              getEnv("DB_NAME", "comcamp_db"),
		DBSSLMode:           getEnv("DB_SSLMODE", "disable"),
		JWTSecret:           jwtSecret,
		UploadDir:           getEnv("UPLOAD_DIR", "./uploads"),
		FrontendURL:         frontendURL,
		CORSAllowedOrigins:  corsOrigins,
		TrustedProxies:      parseCSV(trustedProxyRaw),
		AllowMemoryFallback: getEnvBool("ALLOW_MEMORY_FALLBACK", !isProd),
		AdminSeedUsername:   strings.TrimSpace(getEnv("ADMIN_USERNAME", "admin")),
		AdminSeedPassword:   os.Getenv("ADMIN_PASSWORD"),
		EnableSwagger:       getEnvBool("ENABLE_SWAGGER", !isProd),
	}
}

func (c *Config) IsProduction() bool {
	return c.AppEnv == "production" || c.AppEnv == "prod"
}

func (c *Config) IsDevelopment() bool {
	return c.AppEnv == "development" || c.AppEnv == "dev"
}

// Validate checks required and security-sensitive configuration settings before startup.
func (c *Config) Validate() error {
	if strings.TrimSpace(c.Port) == "" {
		return errors.New("PORT must not be empty")
	}
	if p, err := strconv.Atoi(c.Port); err != nil || p <= 0 || p > 65535 {
		return fmt.Errorf("PORT %q is not a valid TCP port", c.Port)
	}

	for _, entry := range c.TrustedProxies {
		if net.ParseIP(entry) == nil {
			if _, _, err := net.ParseCIDR(entry); err != nil {
				return fmt.Errorf("invalid TRUSTED_PROXIES entry %q: must be an IP or CIDR", entry)
			}
		}
	}

	if c.IsProduction() {
		if c.AllowMemoryFallback {
			return errors.New("ALLOW_MEMORY_FALLBACK must be false in production")
		}
		if len(c.JWTSecret) < 32 {
			return errors.New("JWT_SECRET must be at least 32 bytes in production")
		}
		if isInsecureJWTSecret(c.JWTSecret) {
			return errors.New("JWT_SECRET must not use an insecure default placeholder in production")
		}
		if strings.TrimSpace(c.DBPassword) == "" || c.DBPassword == defaultPlaceholderDBPassword {
			return errors.New("DB_PASSWORD must be set to a strong non-default password in production")
		}
		for _, origin := range c.CORSAllowedOrigins {
			if origin == "*" {
				return errors.New("CORS_ALLOWED_ORIGINS must not contain '*' in production")
			}
		}
		if c.AdminSeedPassword != "" && isWeakAdminPassword(c.AdminSeedPassword) {
			return errors.New("ADMIN_PASSWORD is too weak or uses an insecure default for production")
		}
	} else {
		if len(c.JWTSecret) < 32 {
			return errors.New("JWT_SECRET must be at least 32 bytes")
		}
	}

	return nil
}

func (c *Config) DSN() string {
	return fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=%s",
		c.DBHost, c.DBPort, c.DBUser, c.DBPassword, c.DBName, c.DBSSLMode)
}

func parseCORSOrigins(raw, frontendURL string, isProd bool) []string {
	if raw != "" {
		return parseCSV(raw)
	}

	var origins []string
	seen := make(map[string]struct{})
	add := func(origin string) {
		origin = strings.TrimSpace(origin)
		if origin == "" {
			return
		}
		if _, ok := seen[origin]; !ok {
			seen[origin] = struct{}{}
			origins = append(origins, origin)
		}
	}

	if !isProd {
		for _, origin := range defaultDevCORSOrigins {
			add(origin)
		}
	}
	if frontendURL != "" {
		add(frontendURL)
	}
	return origins
}

func parseCSV(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	seen := make(map[string]struct{}, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; !ok {
			seen[trimmed] = struct{}{}
			out = append(out, trimmed)
		}
	}
	return out
}

func generateRandomSecret(numBytes int) string {
	b := make([]byte, numBytes)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	return hex.EncodeToString(b)
}

func isInsecureJWTSecret(secret string) bool {
	lower := strings.ToLower(strings.TrimSpace(secret))
	switch lower {
	case defaultPlaceholderJWTSecret,
		"super-secret-jwt-key-change-in-production",
		"secret",
		"changeme",
		"change_me":
		return true
	}
	return strings.HasPrefix(lower, "change_this")
}

func isWeakAdminPassword(pw string) bool {
	if len(pw) < 12 {
		return true
	}
	lower := strings.ToLower(strings.TrimSpace(pw))
	switch lower {
	case "strong_password",
		"admin123",
		"admin12345678",
		"password1234",
		"change_this_strong_password",
		"change_this_admin_password":
		return true
	}
	return strings.HasPrefix(lower, "change_this")
}

func getEnv(key, defaultVal string) string {
	if val, ok := os.LookupEnv(key); ok && val != "" {
		return val
	}
	return defaultVal
}

func getEnvInt(key string, defaultVal int) int {
	if val, ok := os.LookupEnv(key); ok {
		if intVal, err := strconv.Atoi(val); err == nil {
			return intVal
		}
	}
	return defaultVal
}

func getEnvBool(key string, defaultVal bool) bool {
	if val, ok := os.LookupEnv(key); ok && strings.TrimSpace(val) != "" {
		if parsed, err := strconv.ParseBool(strings.TrimSpace(val)); err == nil {
			return parsed
		}
	}
	return defaultVal
}
