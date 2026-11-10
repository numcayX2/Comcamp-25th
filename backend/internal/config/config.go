package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/netip"
	"os"
	"strings"

	"github.com/joho/godotenv"
)

const (
	EnvProduction  = "production"
	EnvDevelopment = "development"

	// MinJWTSecretLen is the minimum HS256 key length we accept (256 bits of input).
	MinJWTSecretLen = 32
)

type Config struct {
	Env         string
	Port        string
	DBHost      string
	DBPort      string
	DBUser      string
	DBPassword  string
	DBName      string
	DBSSLMode   string
	JWTSecret   string
	UploadDir   string
	FrontendURL string

	// AllowedOrigins is the CORS allow-list: FRONTEND_URL (comma separated), plus the local
	// dev servers when running in development.
	AllowedOrigins []string
	// TrustedProxies lists the reverse proxies whose X-Forwarded-For / X-Real-IP we believe.
	// Empty means the TCP peer address is always the client IP.
	TrustedProxies []netip.Prefix
	EnableSwagger  bool

	// DevAdminUsername / DevAdminPassword seed an admin for the in-memory development store only.
	DevAdminUsername string
	DevAdminPassword string
}

func (c *Config) IsProduction() bool { return c.Env == EnvProduction }

// Load reads configuration from the environment (and .env files when present).
//
// It fails closed (AGENTS.md §13.2): APP_ENV defaults to "production", and in production every
// secret must come from the environment — there are no fallback secrets in the repository.
// In development a missing JWT_SECRET is replaced by a random per-process key, never a constant.
func Load() (*Config, error) {
	// Try loading from .env in backend directory or parent directory
	_ = godotenv.Load()
	_ = godotenv.Load("../.env")

	env := strings.ToLower(getEnv("APP_ENV", EnvProduction))
	if env != EnvProduction && env != EnvDevelopment {
		return nil, fmt.Errorf("APP_ENV must be %q or %q, got %q", EnvProduction, EnvDevelopment, env)
	}

	cfg := &Config{
		Env:              env,
		Port:             getEnv("PORT", "8000"),
		DBHost:           getEnv("DB_HOST", "127.0.0.1"),
		DBPort:           getEnv("DB_PORT", "5432"),
		DBUser:           getEnv("DB_USER", "comcamp"),
		DBPassword:       os.Getenv("DB_PASSWORD"),
		DBName:           getEnv("DB_NAME", "comcamp_db"),
		DBSSLMode:        getEnv("DB_SSLMODE", "disable"),
		JWTSecret:        os.Getenv("JWT_SECRET"),
		UploadDir:        getEnv("UPLOAD_DIR", "./uploads"),
		FrontendURL:      strings.TrimSpace(os.Getenv("FRONTEND_URL")),
		DevAdminUsername: getEnv("DEV_ADMIN_USERNAME", "admin"),
		DevAdminPassword: os.Getenv("DEV_ADMIN_PASSWORD"),
	}

	var problems []string

	switch {
	case cfg.JWTSecret == "" && cfg.IsProduction():
		problems = append(problems, "JWT_SECRET is required")
	case cfg.JWTSecret == "":
		cfg.JWTSecret = randomSecret()
		log.Println("WARNING: JWT_SECRET not set; using a random development key (admin tokens reset on restart)")
	case len(cfg.JWTSecret) < MinJWTSecretLen:
		problems = append(problems, fmt.Sprintf("JWT_SECRET must be at least %d characters", MinJWTSecretLen))
	case isPlaceholder(cfg.JWTSecret):
		problems = append(problems, "JWT_SECRET still has the placeholder value from .env.example")
	}

	if cfg.IsProduction() {
		if cfg.DBPassword == "" {
			problems = append(problems, "DB_PASSWORD is required")
		} else if isPlaceholder(cfg.DBPassword) {
			problems = append(problems, "DB_PASSWORD still has the placeholder value from .env.example")
		}
		if cfg.FrontendURL == "" {
			problems = append(problems, "FRONTEND_URL is required (the site origin allowed by CORS)")
		}
		if cfg.DevAdminPassword != "" {
			problems = append(problems, "DEV_ADMIN_PASSWORD must not be set in production")
		}
	}

	for _, origin := range splitList(cfg.FrontendURL) {
		cfg.AllowedOrigins = append(cfg.AllowedOrigins, strings.TrimRight(origin, "/"))
	}
	if !cfg.IsProduction() {
		cfg.AllowedOrigins = append(cfg.AllowedOrigins,
			"http://localhost:4321", "http://127.0.0.1:4321", "http://localhost:3000")
	}

	for _, raw := range splitList(os.Getenv("TRUSTED_PROXIES")) {
		prefix, err := parsePrefix(raw)
		if err != nil {
			problems = append(problems, fmt.Sprintf("TRUSTED_PROXIES: %v", err))
			continue
		}
		cfg.TrustedProxies = append(cfg.TrustedProxies, prefix)
	}

	cfg.EnableSwagger = !cfg.IsProduction() || strings.EqualFold(os.Getenv("ENABLE_SWAGGER"), "true")

	if len(problems) > 0 {
		return nil, errors.New("invalid configuration (APP_ENV=" + cfg.Env + "):\n  - " + strings.Join(problems, "\n  - "))
	}
	return cfg, nil
}

func (c *Config) DSN() string {
	return fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=%s",
		c.DBHost, c.DBPort, c.DBUser, c.DBPassword, c.DBName, c.DBSSLMode)
}

func getEnv(key, defaultVal string) string {
	if val, ok := os.LookupEnv(key); ok && val != "" {
		return val
	}
	return defaultVal
}

func splitList(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// parsePrefix accepts either a CIDR ("10.0.0.0/8") or a single address ("127.0.0.1").
func parsePrefix(s string) (netip.Prefix, error) {
	if strings.Contains(s, "/") {
		p, err := netip.ParsePrefix(s)
		if err != nil {
			return netip.Prefix{}, err
		}
		return p.Masked(), nil
	}
	addr, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Prefix{}, err
	}
	addr = addr.Unmap()
	return netip.PrefixFrom(addr, addr.BitLen()), nil
}

// isPlaceholder catches the sample values shipped in .env.example being deployed as-is.
func isPlaceholder(v string) bool {
	return strings.HasPrefix(v, "change_this") || strings.HasPrefix(v, "CHANGE_ME")
}

func randomSecret() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand never fails on supported platforms
	}
	return hex.EncodeToString(b)
}
