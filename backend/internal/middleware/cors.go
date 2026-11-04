package middleware

import (
	"net/http"

	"github.com/go-chi/cors"
)

func NewCORS(frontendURL string) func(http.Handler) http.Handler {
	origins := []string{"http://localhost:4321", "http://127.0.0.1:4321", "http://localhost:3000"}
	if frontendURL != "" {
		origins = append(origins, frontendURL)
	}

	return cors.Handler(cors.Options{
		AllowedOrigins:   origins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-CSRF-Token"},
		ExposedHeaders:   []string{"Link"},
		AllowCredentials: true,
		MaxAge:           300,
	})
}
