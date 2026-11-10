package middleware

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"
)

func clientIPFor(trusted []netip.Prefix, remote string, headers map[string]string) string {
	var got string
	h := ClientIP(trusted)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = RemoteIP(r)
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = remote
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	h.ServeHTTP(httptest.NewRecorder(), req)
	return got
}

func TestClientIP(t *testing.T) {
	proxy := []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32"), netip.MustParsePrefix("10.0.0.0/8")}

	cases := []struct {
		name    string
		trusted []netip.Prefix
		remote  string
		headers map[string]string
		want    string
	}{
		{"no proxies configured ignores XFF", nil, "198.51.100.7:5000",
			map[string]string{"X-Forwarded-For": "1.2.3.4"}, "198.51.100.7"},
		{"untrusted peer ignores XFF", proxy, "198.51.100.7:5000",
			map[string]string{"X-Forwarded-For": "1.2.3.4"}, "198.51.100.7"},
		{"trusted proxy uses XFF", proxy, "127.0.0.1:5000",
			map[string]string{"X-Forwarded-For": "203.0.113.5"}, "203.0.113.5"},
		{"client-supplied XFF prefix is not trusted", proxy, "127.0.0.1:5000",
			map[string]string{"X-Forwarded-For": "6.6.6.6, 203.0.113.5"}, "203.0.113.5"},
		{"chained trusted proxies are skipped", proxy, "127.0.0.1:5000",
			map[string]string{"X-Forwarded-For": "203.0.113.5, 10.1.2.3"}, "203.0.113.5"},
		{"X-Real-IP from trusted proxy", proxy, "127.0.0.1:5000",
			map[string]string{"X-Real-IP": "203.0.113.9"}, "203.0.113.9"},
		{"garbage XFF falls back to peer", proxy, "127.0.0.1:5000",
			map[string]string{"X-Forwarded-For": "not-an-ip"}, "127.0.0.1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := clientIPFor(tc.trusted, tc.remote, tc.headers); got != tc.want {
				t.Fatalf("want %s, got %s", tc.want, got)
			}
		})
	}
}

func TestRateLimiterWindowResets(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	l := NewRateLimiter(2, time.Minute)
	l.now = func() time.Time { return now }

	for i := 0; i < 2; i++ {
		if ok, _ := l.Allow("ip"); !ok {
			t.Fatalf("hit %d should pass", i+1)
		}
	}
	if ok, retry := l.Allow("ip"); ok || retry <= 0 {
		t.Fatalf("3rd hit should be limited with a retry delay, got ok=%v retry=%v", ok, retry)
	}
	if ok, _ := l.Allow("other-ip"); !ok {
		t.Fatal("limits must be per key")
	}

	now = now.Add(time.Minute)
	if ok, _ := l.Allow("ip"); !ok {
		t.Fatal("window should reset")
	}
}
