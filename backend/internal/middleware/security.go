package middleware

import (
	"log"
	"net/http"
	"time"

	chimiddleware "github.com/go-chi/chi/v5/middleware"

	"comcamp25-backend/internal/pkg/response"
)

// MaxJSONBodyBytes caps every JSON request body. The largest legitimate payload (an application
// with a long motivation) is a few KB.
const MaxJSONBodyBytes = 64 << 10

// LimitBody wraps the request body in http.MaxBytesReader so an oversized body fails while it is
// being read instead of being buffered in memory (AGENTS.md §13.3).
func LimitBody(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.ContentLength > maxBytes {
				response.ErrorCode(w, http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge, "request body too large")
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			next.ServeHTTP(w, r)
		})
	}
}

// APIHeaders sets defensive headers for JSON API responses. Responses carry personal data, so
// they must not be cached by browsers or shared proxies.
func APIHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		h.Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

// AccessLog logs one line per request without the query string: GET /api/applications/status
// carries a national ID or phone number in ?q=, which must not end up in server logs (PDPA).
func AccessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := chimiddleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		log.Printf("[%s] %s %s %s -> %d %dB in %s",
			chimiddleware.GetReqID(r.Context()), RemoteIP(r), r.Method, r.URL.Path,
			ww.Status(), ww.BytesWritten(), time.Since(start).Round(time.Millisecond))
	})
}
