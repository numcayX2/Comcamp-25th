package middleware

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// fakeClock is a hand-driven clock for the limiter.
type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

func newTestLimiter(limit int, window time.Duration, maxBuckets int) (*RateLimiter, *fakeClock) {
	c := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	l := NewRateLimiter(limit, window)
	l.now = c.now
	l.maxBuckets = maxBuckets
	return l, c
}

func TestRateLimiter_DefaultCapIs50k(t *testing.T) {
	if l := NewRateLimiter(1, time.Minute); l.maxBuckets != 50_000 {
		t.Fatalf("default cap = %d, want 50000", l.maxBuckets)
	}
}

func TestRateLimiter_TableNeverExceedsTheCap(t *testing.T) {
	l, c := newTestLimiter(5, time.Minute, 100)
	// A flood of one-shot keys, well past the cap, all inside one window.
	for i := 0; i < 10_000; i++ {
		l.Allow(fmt.Sprintf("bot-%d", i))
		c.advance(time.Millisecond)
		if n := l.size(); n > 100 {
			t.Fatalf("after %d keys the table holds %d buckets, cap is 100", i+1, n)
		}
	}
	if n := l.size(); n != 100 {
		t.Fatalf("a full table should stay at the cap, got %d", n)
	}
	if q := len(l.queue) - l.head; q > 100 {
		t.Fatalf("the expiry queue holds %d live slots for a cap of 100 (it must not grow with the flood)", q)
	}
}

func TestRateLimiter_FullTableEvictsTheOldestBucket(t *testing.T) {
	l, c := newTestLimiter(1, time.Minute, 3)
	for _, k := range []string{"a", "b", "c"} {
		l.Allow(k)
		c.advance(time.Second)
	}
	l.Allow("d") // table is full of live buckets: the oldest ("a") makes room

	if n := l.size(); n != 3 {
		t.Fatalf("size = %d, want 3", n)
	}
	if _, ok := l.buckets["a"]; ok {
		t.Fatal("the oldest bucket (a) should have been evicted")
	}
	for _, k := range []string{"b", "c", "d"} {
		if _, ok := l.buckets[k]; !ok {
			t.Fatalf("bucket %s should have been kept", k)
		}
	}
	// A kept key still has its counter: its second hit in the window is over the limit of 1.
	if ok, _ := l.Allow("b"); ok {
		t.Fatal("b kept its count, so its 2nd hit must be limited")
	}
}

func TestRateLimiter_FullTableSweepsExpiredBeforeEvictingLiveOnes(t *testing.T) {
	l, c := newTestLimiter(1, time.Minute, 3)
	l.Allow("old-1")
	l.Allow("old-2")
	c.advance(59 * time.Second)
	l.Allow("live") // the table is now full (3)
	c.advance(2 * time.Second)

	// old-1 and old-2 expired a second ago; the live bucket must survive the new key.
	l.Allow("new")
	if _, ok := l.buckets["live"]; !ok {
		t.Fatal("a live bucket was evicted although expired ones could be swept")
	}
	if n := l.size(); n != 2 {
		t.Fatalf("size = %d, want 2 (live + new)", n)
	}
	if ok, _ := l.Allow("live"); ok {
		t.Fatal("live kept its counter, so its 2nd hit must be limited")
	}
}

func TestRateLimiter_ExistingKeyAtCapacityEvictsNothing(t *testing.T) {
	l, _ := newTestLimiter(10, time.Minute, 3)
	for _, k := range []string{"a", "b", "c"} {
		l.Allow(k)
	}
	l.Allow("a")
	l.Allow("c")
	if n := l.size(); n != 3 {
		t.Fatalf("size = %d, want 3", n)
	}
	for _, k := range []string{"a", "b", "c"} {
		if _, ok := l.buckets[k]; !ok {
			t.Fatalf("hitting an existing key must not evict %s", k)
		}
	}
}

func TestRateLimiter_ExpiredKeyIsRecreatedAndOldQueueEntryIsHarmless(t *testing.T) {
	l, c := newTestLimiter(1, time.Minute, 10)
	l.Allow("a")
	c.advance(time.Minute)
	if ok, _ := l.Allow("a"); !ok {
		t.Fatal("window should have reset")
	}
	c.advance(30 * time.Second)
	l.Allow("b")
	c.advance(30 * time.Second) // a's first bucket (stale queue entry) is long expired, its 2nd is too
	l.Allow("c")
	if n := l.size(); n != 2 { // b (30 s old) and c
		t.Fatalf("size = %d, want 2 (b, c)", n)
	}
}

func TestRateLimiter_MemoryStaysBoundedAcrossManyWindows(t *testing.T) {
	l, c := newTestLimiter(3, time.Minute, 500)
	for i := 0; i < 50_000; i++ {
		l.Allow(fmt.Sprintf("k-%d", i%2000)) // 2000 recurring clients over a cap of 500
		c.advance(20 * time.Millisecond)
		if l.size() > 500 {
			t.Fatalf("table grew past the cap: %d", l.size())
		}
	}
	if q := len(l.queue); q > 4000 {
		t.Fatalf("queue backing slice is %d long: consumed slots are not being reclaimed", q)
	}
}

func hitFrom(l *RateLimiter, remote string) int {
	h := l.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = remote
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code
}

func TestRateLimiter_MiddlewareGroupsIPv6ByPrefix64(t *testing.T) {
	l, _ := newTestLimiter(2, time.Minute, 100)

	// Three different /128 addresses of the same /64: one client, so the 3rd is limited.
	if c := hitFrom(l, "[2001:db8:aaaa:1::1]:1000"); c != http.StatusNoContent {
		t.Fatalf("1st hit = %d", c)
	}
	if c := hitFrom(l, "[2001:db8:aaaa:1:ffff:ffff:ffff:ffff]:2000"); c != http.StatusNoContent {
		t.Fatalf("2nd hit = %d", c)
	}
	if c := hitFrom(l, "[2001:db8:aaaa:1:dead:beef:0:7]:3000"); c != http.StatusTooManyRequests {
		t.Fatalf("a 3rd address in the same /64 must share the budget, got %d", c)
	}

	// A different /64 has its own budget.
	if c := hitFrom(l, "[2001:db8:aaaa:2::1]:1000"); c != http.StatusNoContent {
		t.Fatalf("another /64 must not be limited, got %d", c)
	}
	if n := l.size(); n != 2 {
		t.Fatalf("two /64 prefixes should be two buckets, got %d", n)
	}
}

func TestRateLimiter_MiddlewareKeepsIPv4PerAddress(t *testing.T) {
	l, _ := newTestLimiter(1, time.Minute, 100)
	if c := hitFrom(l, "198.51.100.7:1"); c != http.StatusNoContent {
		t.Fatal(c)
	}
	if c := hitFrom(l, "198.51.100.8:1"); c != http.StatusNoContent {
		t.Fatalf("a neighbouring IPv4 address is a different client, got %d", c)
	}
	if c := hitFrom(l, "198.51.100.7:2"); c != http.StatusTooManyRequests {
		t.Fatalf("same IPv4 address must be limited, got %d", c)
	}
}
