package middleware

import (
	"net/http"

	"github.com/go-chi/cors"
)

// NewCORS allows only the configured site origins. Admin auth uses a Bearer header, not cookies,
// so credentials are not allowed cross-origin.
func NewCORS(allowedOrigins []string) func(http.Handler) http.Handler {
	return cors.Handler(cors.Options{
		AllowedOrigins:   allowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-Idempotency-Key"},
		ExposedHeaders:   []string{"Retry-After", "Idempotent-Replayed"},
		AllowCredentials: false,
		MaxAge:           300,
	})
}
