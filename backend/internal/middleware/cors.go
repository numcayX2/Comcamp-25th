package middleware

import (
	"net/http"
	"strings"

	"github.com/go-chi/cors"
)

func NewCORS(allowedOrigins []string) func(http.Handler) http.Handler {
	origins := make([]string, 0, len(allowedOrigins))
	seen := make(map[string]struct{}, len(allowedOrigins))
	hasWildcard := false

	for _, origin := range allowedOrigins {
		trimmed := strings.TrimSpace(origin)
		if trimmed == "" {
			continue
		}
		if trimmed == "*" {
			hasWildcard = true
		}
		if _, ok := seen[trimmed]; !ok {
			seen[trimmed] = struct{}{}
			origins = append(origins, trimmed)
		}
	}

	// Only allow credentials when explicit non-wildcard origins are configured.
	allowCredentials := len(origins) > 0 && !hasWildcard

	return cors.Handler(cors.Options{
		AllowedOrigins:   origins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-CSRF-Token"},
		ExposedHeaders:   []string{"Link"},
		AllowCredentials: allowCredentials,
		MaxAge:           300,
	})
}
