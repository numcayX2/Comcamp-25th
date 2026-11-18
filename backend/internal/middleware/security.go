package middleware

import (
	"log"
	"net/http"
	"regexp"
	"strings"
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
// carries a national ID or phone number in ?q=, which must not end up in server logs (PDPA). The
// application code in the path (/api/applications/CC25-XXXXXX/slip) is a credential for the
// code-keyed endpoints, so it is masked too (see MaskLogPath).
func AccessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := chimiddleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		log.Printf("[%s] %s %s %s -> %d %dB in %s",
			chimiddleware.GetReqID(r.Context()), RemoteIP(r), r.Method, MaskLogPath(r.URL.Path),
			ww.Status(), ww.BytesWritten(), time.Since(start).Round(time.Millisecond))
	})
}

// maskedCode replaces an application code in a logged path.
const maskedCode = "CC25-******"

// staticApplicationSegments are the fixed words that follow /applications/ in the routes; any other
// segment there is an {id} (an application code in any form the service accepts) and is masked.
var staticApplicationSegments = map[string]bool{"status": true, "public": true, "export-audit": true}

// looseCodeRe catches a code anywhere else in a path: any case, with or without the hyphen (or a
// space / Unicode dash), with Thai digits allowed.
var looseCodeRe = regexp.MustCompile(`(?i)CC[2\x{0E52}][5\x{0E55}][-\s\x{2010}-\x{2015}\x{2212}]?[0-9A-F\x{0E50}-\x{0E59}]{6}`)

// MaskLogPath returns path with every application code replaced by CC25-******. The whole segment
// after /applications/ is masked (unless it is a fixed route word), whatever its spelling, because
// the service normalizes many spellings (lowercase, no hyphen, Thai digits, zero-width characters)
// to the same code.
func MaskLogPath(path string) string {
	parts := strings.Split(path, "/")
	for i := 0; i+1 < len(parts); i++ {
		if strings.EqualFold(parts[i], "applications") && parts[i+1] != "" &&
			!staticApplicationSegments[strings.ToLower(parts[i+1])] {
			parts[i+1] = maskedCode
		}
	}
	return looseCodeRe.ReplaceAllString(strings.Join(parts, "/"), maskedCode)
}
