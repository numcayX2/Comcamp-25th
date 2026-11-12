package middleware

import (
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	chimiddleware "github.com/go-chi/chi/v5/middleware"
)

// SecurityHeaders adds baseline HTTP security response headers.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		next.ServeHTTP(w, r)
	})
}

// SafeLogger logs HTTP requests while redacting sensitive query parameters (e.g., ?q= on /api/applications/status).
func SafeLogger(next http.Handler) http.Handler {
	return SafeLoggerWithProxies(nil)(next)
}

// SafeLoggerWithProxies logs HTTP requests using trusted proxy IP extraction and PII-redacted URLs.
func SafeLoggerWithProxies(trustedProxies []string) func(http.Handler) http.Handler {
	parsedProxies := ParseTrustedProxies(trustedProxies)
	return newSafeLogger(parsedProxies)
}

func newSafeLogger(parsedProxies []*net.IPNet) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := chimiddleware.NewWrapResponseWriter(w, r.ProtoMajor)

			next.ServeHTTP(ww, r)

			reqID := chimiddleware.GetReqID(r.Context())
			clientIP := ClientIP(r, parsedProxies)
			target := sanitizeRequestTarget(r.URL)

			if reqID != "" {
				log.Printf("[%s] %s %s from=%s status=%d bytes=%d duration=%s",
					reqID, r.Method, target, clientIP, ww.Status(), ww.BytesWritten(), time.Since(start))
			} else {
				log.Printf("%s %s from=%s status=%d bytes=%d duration=%s",
					r.Method, target, clientIP, ww.Status(), ww.BytesWritten(), time.Since(start))
			}
		})
	}
}

func sanitizeRequestTarget(u *url.URL) string {
	if u == nil {
		return ""
	}
	if u.RawQuery == "" {
		return u.Path
	}

	q := u.Query()
	if strings.HasPrefix(u.Path, "/api/applications/status") && q.Has("q") {
		q.Set("q", "REDACTED")
	}
	for _, sensitiveKey := range []string{"token", "password", "secret"} {
		if q.Has(sensitiveKey) {
			q.Set(sensitiveKey, "REDACTED")
		}
	}

	encoded := q.Encode()
	if encoded == "" {
		return u.Path
	}
	return u.Path + "?" + encoded
}
