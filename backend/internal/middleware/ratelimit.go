package middleware

import (
	"math"
	"net/http"
	"strconv"
	"sync"
	"time"

	"comcamp25-backend/internal/pkg/response"
)

// RateLimiter is a fixed-window counter keyed by client IP (AGENTS.md §13.4 anti-spam).
// It is in-process only, which is fine for the single API instance this camp runs; put a shared
// store behind it before scaling out horizontally.
type RateLimiter struct {
	limit  int
	window time.Duration
	now    func() time.Time

	mu      sync.Mutex
	buckets map[string]*bucket
	sweptAt time.Time
}

type bucket struct {
	count   int
	resetAt time.Time
}

func NewRateLimiter(limit int, window time.Duration) *RateLimiter {
	return &RateLimiter{
		limit:   limit,
		window:  window,
		now:     time.Now,
		buckets: make(map[string]*bucket),
	}
}

// Allow records one hit for key and reports whether it is within the limit, plus how long until
// the window resets.
func (l *RateLimiter) Allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	l.sweep(now)

	b, ok := l.buckets[key]
	if !ok || !now.Before(b.resetAt) {
		b = &bucket{resetAt: now.Add(l.window)}
		l.buckets[key] = b
	}
	b.count++
	return b.count <= l.limit, b.resetAt.Sub(now)
}

// sweep drops expired buckets at most once per window so memory stays bounded.
func (l *RateLimiter) sweep(now time.Time) {
	if now.Sub(l.sweptAt) < l.window {
		return
	}
	for k, b := range l.buckets {
		if !now.Before(b.resetAt) {
			delete(l.buckets, k)
		}
	}
	l.sweptAt = now
}

// Middleware rejects requests over the limit with 429 and a Retry-After header.
func (l *RateLimiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ok, retry := l.Allow(RemoteIP(r))
		if !ok {
			w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(retry.Seconds()))))
			response.ErrorCode(w, http.StatusTooManyRequests, response.CodeRateLimited,
				"too many requests, please try again shortly")
			return
		}
		next.ServeHTTP(w, r)
	})
}
