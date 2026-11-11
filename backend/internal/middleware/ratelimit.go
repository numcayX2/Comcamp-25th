package middleware

import (
	"math"
	"net/http"
	"strconv"
	"sync"
	"time"

	"comcamp25-backend/internal/pkg/response"
)

// DefaultMaxBuckets caps how many distinct keys one RateLimiter remembers. Keys come from the
// network (client IP), so without a cap a bot flood from many addresses would grow the map without
// limit until the process runs out of memory.
const DefaultMaxBuckets = 50_000

// RateLimiter is a fixed-window counter keyed by client (see RateLimitKey; AGENTS.md section 13.4
// anti-spam). It is in-process only, which is fine for the single API instance this camp runs; put
// a shared store behind it before scaling out horizontally.
//
// Memory is strictly bounded by maxBuckets. Every bucket lives exactly one window and is created
// in clock order, so the buckets form a queue ordered by expiry: expired ones are dropped from the
// front on every call (cheap, no full scan), and when the table is still full the oldest, i.e.
// soonest-to-expire, bucket is evicted to make room. Under a flood the cost is that the oldest
// callers lose their counter early, which is far better than running out of memory.
type RateLimiter struct {
	limit      int
	window     time.Duration
	now        func() time.Time
	maxBuckets int

	mu      sync.Mutex
	buckets map[string]*bucket
	queue   []*bucket // creation order == expiry order; may hold stale entries (see sweep)
	head    int       // queue[:head] is already consumed
}

type bucket struct {
	key     string
	count   int
	resetAt time.Time
}

func NewRateLimiter(limit int, window time.Duration) *RateLimiter {
	return &RateLimiter{
		limit:      limit,
		window:     window,
		now:        time.Now,
		maxBuckets: DefaultMaxBuckets,
		buckets:    make(map[string]*bucket),
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
		if !ok && len(l.buckets) >= l.maxBuckets {
			// sweep above already dropped everything expired, so the table is full of live
			// buckets: evict the oldest ones to stay within the cap.
			l.evict(len(l.buckets) - l.maxBuckets + 1)
		}
		b = &bucket{key: key, resetAt: now.Add(l.window)}
		l.buckets[key] = b
		l.queue = append(l.queue, b)
	}
	b.count++
	return b.count <= l.limit, b.resetAt.Sub(now)
}

// sweep drops expired buckets from the front of the queue. A queue entry whose bucket is no longer
// the one in the map (it was replaced after expiring) is stale and is skipped.
func (l *RateLimiter) sweep(now time.Time) {
	for l.head < len(l.queue) {
		b := l.queue[l.head]
		if l.buckets[b.key] == b {
			if now.Before(b.resetAt) {
				break
			}
			delete(l.buckets, b.key)
		}
		l.queue[l.head] = nil
		l.head++
	}
	l.compact()
}

// evict removes the n oldest live buckets.
func (l *RateLimiter) evict(n int) {
	for n > 0 && l.head < len(l.queue) {
		b := l.queue[l.head]
		if l.buckets[b.key] == b {
			delete(l.buckets, b.key)
			n--
		}
		l.queue[l.head] = nil
		l.head++
	}
	l.compact()
}

// compact reclaims the consumed front of the queue once it is the larger half.
func (l *RateLimiter) compact() {
	if l.head == len(l.queue) {
		l.queue, l.head = l.queue[:0], 0
		return
	}
	if l.head > 1024 && l.head*2 > len(l.queue) {
		n := copy(l.queue, l.queue[l.head:])
		clear(l.queue[n:])
		l.queue, l.head = l.queue[:n], 0
	}
}

// size reports how many buckets are held (tests).
func (l *RateLimiter) size() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}

// Middleware rejects requests over the limit with 429 and a Retry-After header.
func (l *RateLimiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ok, retry := l.Allow(RateLimitKey(r))
		if !ok {
			w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(retry.Seconds()))))
			response.ErrorCode(w, http.StatusTooManyRequests, response.CodeRateLimited,
				"too many requests, please try again shortly")
			return
		}
		next.ServeHTTP(w, r)
	})
}
