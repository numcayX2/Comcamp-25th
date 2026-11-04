package config

import (
	"fmt"
	"os"
	"strconv"

	"github.com/joho/godotenv"
)

type Config struct {
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
}

func Load() *Config {
	// Try loading from .env in backend directory or parent directory
	_ = godotenv.Load()
	_ = godotenv.Load("../.env")

	return &Config{
		Port:        getEnv("PORT", "8000"),
		DBHost:      getEnv("DB_HOST", "127.0.0.1"),
		DBPort:      getEnv("DB_PORT", "5432"),
		DBUser:      getEnv("DB_USER", "comcamp"),
		DBPassword:  getEnv("DB_PASSWORD", "change_this_strong_password"),
		DBName:      getEnv("DB_NAME", "comcamp_db"),
		DBSSLMode:   getEnv("DB_SSLMODE", "disable"),
		JWTSecret:   getEnv("JWT_SECRET", "change_this_to_min_32_chars_secret"),
		UploadDir:   getEnv("UPLOAD_DIR", "./uploads"),
		FrontendURL: getEnv("FRONTEND_URL", "http://localhost:4321"),
	}
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

func getEnvInt(key string, defaultVal int) int {
	if val, ok := os.LookupEnv(key); ok {
		if intVal, err := strconv.Atoi(val); err == nil {
			return intVal
		}
	}
	return defaultVal
}
