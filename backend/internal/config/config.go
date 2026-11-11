package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net"
	"net/netip"
	"net/url"
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

	// TurnstileSecretKey is the Cloudflare Turnstile server secret (TURNSTILE_SECRET_KEY) that
	// guards POST /api/applications. Required in production; empty in development bypasses the
	// check (with a warning) so the API can run without Cloudflare.
	TurnstileSecretKey string

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

// TurnstileAllowedHosts lists the hostnames a Turnstile token may have been issued for: the
// FRONTEND_URL hosts, plus localhost / 127.0.0.1 in development.
func (c *Config) TurnstileAllowedHosts() []string {
	var hosts []string
	for _, origin := range splitList(c.FrontendURL) {
		if u, err := url.Parse(origin); err == nil && u.Hostname() != "" {
			hosts = append(hosts, strings.ToLower(u.Hostname()))
		}
	}
	if !c.IsProduction() {
		hosts = append(hosts, "localhost", "127.0.0.1")
	}
	return hosts
}

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
		Env:                env,
		Port:               getEnv("PORT", "8000"),
		DBHost:             getEnv("DB_HOST", "127.0.0.1"),
		DBPort:             getEnv("DB_PORT", "5432"),
		DBUser:             getEnv("DB_USER", "comcamp"),
		DBPassword:         os.Getenv("DB_PASSWORD"),
		DBName:             getEnv("DB_NAME", "comcamp_db"),
		DBSSLMode:          getEnv("DB_SSLMODE", "disable"),
		JWTSecret:          os.Getenv("JWT_SECRET"),
		UploadDir:          getEnv("UPLOAD_DIR", "./uploads"),
		FrontendURL:        strings.TrimSpace(os.Getenv("FRONTEND_URL")),
		TurnstileSecretKey: strings.TrimSpace(os.Getenv("TURNSTILE_SECRET_KEY")),
		DevAdminUsername:   getEnv("DEV_ADMIN_USERNAME", "admin"),
		DevAdminPassword:   os.Getenv("DEV_ADMIN_PASSWORD"),
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
		switch {
		case cfg.TurnstileSecretKey == "":
			problems = append(problems, "TURNSTILE_SECRET_KEY is required (Cloudflare Turnstile secret for the registration form)")
		case isPlaceholder(cfg.TurnstileSecretKey):
			problems = append(problems, "TURNSTILE_SECRET_KEY still has the placeholder value from .env.example")
		case isTurnstileTestSecret(cfg.TurnstileSecretKey):
			problems = append(problems, "TURNSTILE_SECRET_KEY is a Cloudflare dummy test secret, use the real secret in production")
		}
	} else if cfg.TurnstileSecretKey == "" {
		log.Println("WARNING: TURNSTILE_SECRET_KEY not set; Turnstile verification is BYPASSED for local development (never do this in production)")
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

// DSN is a postgres:// URL. net/url percent-encodes the user, password and database name, so a
// password with spaces, quotes, backslashes, '@' or '=' can neither break the string nor smuggle in
// another connection parameter (the old "key=value ..." form allowed both). net.JoinHostPort puts
// brackets around an IPv6 host.
func (c *Config) DSN() string {
	u := url.URL{
		Scheme:   "postgres",
		User:     url.UserPassword(c.DBUser, c.DBPassword),
		Host:     net.JoinHostPort(c.DBHost, c.DBPort),
		Path:     "/" + c.DBName,
		RawQuery: url.Values{"sslmode": {c.DBSSLMode}}.Encode(),
	}
	return u.String()
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

// isTurnstileTestSecret matches Cloudflare's documented dummy secrets (1x / 2x / 3x + zeros + AA).
func isTurnstileTestSecret(v string) bool {
	const tail = "x0000000000000000000000000000000AA"
	return len(v) == len(tail)+1 && strings.HasSuffix(v, tail) && strings.ContainsRune("123", rune(v[0]))
}

func randomSecret() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand never fails on supported platforms
	}
	return hex.EncodeToString(b)
}
