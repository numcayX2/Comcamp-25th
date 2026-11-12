package middleware

import (
	"context"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"comcamp25-backend/internal/pkg/response"
)

const defaultMaxRateLimitEntries = 10000

type rateLimitEntry struct {
	count       int
	windowStart time.Time
	lastSeen    time.Time
}

// RateLimiter provides thread-safe per-IP fixed-window rate limiting with a bounded map.
type RateLimiter struct {
	mu             sync.Mutex
	clients        map[string]*rateLimitEntry
	limit          int
	window         time.Duration
	maxEntries     int
	trustedProxies []*net.IPNet
	lastSweep      time.Time
}

func NewRateLimiter(limit int, window time.Duration, trustedProxies []string) *RateLimiter {
	if limit <= 0 {
		limit = 60
	}
	if window <= 0 {
		window = time.Minute
	}
	return &RateLimiter{
		clients:        make(map[string]*rateLimitEntry),
		limit:          limit,
		window:         window,
		maxEntries:     defaultMaxRateLimitEntries,
		trustedProxies: ParseTrustedProxies(trustedProxies),
		lastSweep:      time.Now(),
	}
}

// RateLimit returns a chi-compatible rate-limiting middleware for the given limit/window.
func RateLimit(limit int, window time.Duration, trustedProxies []string) func(http.Handler) http.Handler {
	rl := NewRateLimiter(limit, window, trustedProxies)
	return rl.Middleware
}

// StartCleanup runs periodic expired-entry pruning until ctx is canceled.
func (rl *RateLimiter) StartCleanup(ctx context.Context) {
	interval := rl.window
	if interval < 10*time.Second {
		interval = 10 * time.Second
	}
	ticker := time.NewTicker(interval)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				rl.mu.Lock()
				rl.pruneExpiredLocked(now)
				rl.lastSweep = now
				rl.mu.Unlock()
			}
		}
	}()
}

// Middleware enforces the per-IP request limit and returns 429 Too Many Requests when exceeded.
func (rl *RateLimiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := ClientIP(r, rl.trustedProxies)
		allowed, retryAfter := rl.Allow(ip)
		if !allowed {
			secs := int(retryAfter.Seconds())
			if secs < 1 {
				secs = 1
			}
			w.Header().Set("Retry-After", strconv.Itoa(secs))
			response.Error(w, http.StatusTooManyRequests, "too many requests, please try again later")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (rl *RateLimiter) Allow(ip string) (bool, time.Duration) {
	now := time.Now()

	rl.mu.Lock()
	defer rl.mu.Unlock()

	if now.Sub(rl.lastSweep) >= rl.window || len(rl.clients) >= rl.maxEntries {
		rl.pruneExpiredLocked(now)
		rl.lastSweep = now
	}

	entry, ok := rl.clients[ip]
	if !ok {
		if len(rl.clients) >= rl.maxEntries {
			rl.evictOldestLocked()
		}
		rl.clients[ip] = &rateLimitEntry{
			count:       1,
			windowStart: now,
			lastSeen:    now,
		}
		return true, 0
	}

	if now.Sub(entry.windowStart) >= rl.window {
		entry.count = 1
		entry.windowStart = now
		entry.lastSeen = now
		return true, 0
	}

	entry.lastSeen = now
	if entry.count >= rl.limit {
		retryAfter := rl.window - now.Sub(entry.windowStart)
		return false, retryAfter
	}

	entry.count++
	return true, 0
}

func (rl *RateLimiter) pruneExpiredLocked(now time.Time) {
	for k, v := range rl.clients {
		if now.Sub(v.windowStart) >= rl.window {
			delete(rl.clients, k)
		}
	}
}

func (rl *RateLimiter) evictOldestLocked() {
	var oldestKey string
	var oldestTime time.Time
	first := true
	for k, v := range rl.clients {
		if first || v.lastSeen.Before(oldestTime) {
			oldestKey = k
			oldestTime = v.lastSeen
			first = false
		}
	}
	if !first {
		delete(rl.clients, oldestKey)
	}
}

// ParseTrustedProxies parses IP addresses and CIDRs into net.IPNet entries.
func ParseTrustedProxies(entries []string) []*net.IPNet {
	var nets []*net.IPNet
	for _, entry := range entries {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		if _, cidr, err := net.ParseCIDR(trimmed); err == nil {
			nets = append(nets, cidr)
			continue
		}
		if ip := net.ParseIP(trimmed); ip != nil {
			bits := 128
			if ip.To4() != nil {
				ip = ip.To4()
				bits = 32
			}
			nets = append(nets, &net.IPNet{
				IP:   ip,
				Mask: net.CIDRMask(bits, bits),
			})
		}
	}
	return nets
}

// ClientIP extracts the client IP from RemoteAddr, honoring X-Forwarded-For / X-Real-IP
// only when the immediate peer IP is within trustedProxies.
func ClientIP(r *http.Request, trustedProxies []*net.IPNet) string {
	remoteHost := strings.TrimSpace(r.RemoteAddr)
	if host, _, err := net.SplitHostPort(remoteHost); err == nil {
		remoteHost = host
	}

	remoteIP := net.ParseIP(remoteHost)
	if remoteIP == nil {
		return remoteHost
	}

	if !isTrustedIP(remoteIP, trustedProxies) {
		return remoteIP.String()
	}

	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		// Walk right-to-left and return the first untrusted valid IP to prevent client spoofing.
		var leftmostValid net.IP
		for i := len(parts) - 1; i >= 0; i-- {
			candidate := net.ParseIP(strings.TrimSpace(parts[i]))
			if candidate == nil {
				continue
			}
			leftmostValid = candidate
			if !isTrustedIP(candidate, trustedProxies) {
				return candidate.String()
			}
		}
		if leftmostValid != nil {
			return leftmostValid.String()
		}
	}

	if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
		if candidate := net.ParseIP(xri); candidate != nil {
			return candidate.String()
		}
	}

	return remoteIP.String()
}

func isTrustedIP(ip net.IP, trusted []*net.IPNet) bool {
	for _, network := range trusted {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}
