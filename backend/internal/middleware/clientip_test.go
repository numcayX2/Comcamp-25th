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

func TestRateLimitKey(t *testing.T) {
	cases := []struct {
		name   string
		remote string
		want   string
	}{
		{"ipv4 is kept as is", "198.51.100.7:5000", "198.51.100.7"},
		{"ipv4 without port", "198.51.100.7", "198.51.100.7"},
		{"ipv6 is cut to its /64", "[2001:db8:1234:5678:9abc:def0:1234:5678]:443", "2001:db8:1234:5678::"},
		{"ipv6 host bits do not matter", "[2001:db8:1234:5678:ffff:ffff:ffff:ffff]:443", "2001:db8:1234:5678::"},
		{"ipv6 bare (as ClientIP leaves it)", "2001:db8:1234:5678::1", "2001:db8:1234:5678::"},
		{"neighbouring /64 is a different key", "[2001:db8:1234:5679::1]:443", "2001:db8:1234:5679::"},
		{"zone is dropped", "[fe80::1%eth0]:80", "fe80::"},
		{"ipv4-mapped ipv6 counts as ipv4", "[::ffff:203.0.113.9]:80", "203.0.113.9"},
		{"loopback v6", "[::1]:80", "::"},
		{"garbage falls back to the raw value", "not-an-address", "not-an-address"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			r.RemoteAddr = tc.remote
			if got := RateLimitKey(r); got != tc.want {
				t.Fatalf("RateLimitKey(%q) = %q, want %q", tc.remote, got, tc.want)
			}
		})
	}
}

// ClientIP leaves a bare address in RemoteAddr; the key must still be the /64 when the address
// comes from a trusted proxy's X-Forwarded-For.
func TestRateLimitKey_AfterClientIPWithForwardedIPv6(t *testing.T) {
	trusted := []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
	var got string
	h := ClientIP(trusted)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { got = RateLimitKey(r) }))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "127.0.0.1:5000"
	req.Header.Set("X-Forwarded-For", "2001:db8:aaaa:bbbb:1:2:3:4")
	h.ServeHTTP(httptest.NewRecorder(), req)
	if got != "2001:db8:aaaa:bbbb::" {
		t.Fatalf("got %q, want the /64 prefix", got)
	}
}

// forwardedFor runs ClientIP for a request that carries X-Forwarded-For as separate header lines,
// the way a proxy that appends its own line (instead of extending the first) forwards it.
func forwardedFor(trusted []netip.Prefix, remote string, lines ...string) (ip, key string) {
	h := ClientIP(trusted)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip, key = RemoteIP(r), RateLimitKey(r)
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = remote
	for _, l := range lines {
		req.Header.Add("X-Forwarded-For", l)
	}
	h.ServeHTTP(httptest.NewRecorder(), req)
	return ip, key
}

func TestClientIP_MultipleForwardedForLines(t *testing.T) {
	proxy := []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32"), netip.MustParsePrefix("10.0.0.0/8")}
	cases := []struct {
		name  string
		lines []string
		want  string
	}{
		// The client's own first line says 6.6.6.6; the proxy appended the real address as a second line.
		{"the proxy's last line wins over the client's first line", []string{"6.6.6.6", "203.0.113.5"}, "203.0.113.5"},
		{"three lines, right-most untrusted", []string{"6.6.6.6", "7.7.7.7", "203.0.113.5"}, "203.0.113.5"},
		{"a trusted proxy hop on the last line is skipped", []string{"203.0.113.5", "10.1.2.3"}, "203.0.113.5"},
		{"the client cannot hide the proxy's line behind a comma list", []string{"6.6.6.6, 5.5.5.5", "203.0.113.5"}, "203.0.113.5"},
		{"an empty first line is harmless", []string{"", "203.0.113.5"}, "203.0.113.5"},
		{"an empty last line leaves nothing trustworthy to the right", []string{"203.0.113.5", ""}, "127.0.0.1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got, _ := forwardedFor(proxy, "127.0.0.1:5000", tc.lines...); got != tc.want {
				t.Fatalf("want %s, got %s", tc.want, got)
			}
		})
	}

	// The same lines from a peer that is not a trusted proxy are ignored entirely.
	if got, _ := forwardedFor(proxy, "198.51.100.7:5000", "6.6.6.6", "203.0.113.5"); got != "198.51.100.7" {
		t.Fatalf("untrusted peer must not be able to name its own client IP, got %s", got)
	}
}

func TestClientIP_MalformedHops(t *testing.T) {
	proxy := []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32"), netip.MustParsePrefix("10.0.0.0/8")}
	cases := []struct {
		name  string
		lines []string
		want  string
	}{
		// A valid address written by the proxy, junk before it: the junk is never consulted.
		{"junk to the left of the proxy's hop is ignored", []string{"garbage, 203.0.113.5"}, "203.0.113.5"},
		// Junk at the right: nothing to the left of it can be trusted, so the earlier "client" is not used.
		{"a malformed right-most hop does not let an earlier hop through", []string{"6.6.6.6, garbage"}, "127.0.0.1"},
		{"a malformed hop after a trusted proxy hop stops the walk there", []string{"6.6.6.6, garbage, 10.1.2.3"}, "10.1.2.3"},
		{"unknown (RFC 7239 style token) is malformed", []string{"unknown"}, "127.0.0.1"},
		{"obfuscated identifier is malformed", []string{"_hidden, 203.0.113.5"}, "203.0.113.5"},
		{"a port on an otherwise valid hop is accepted", []string{"203.0.113.5:4711"}, "203.0.113.5"},
		{"a bracketed IPv6 hop is accepted", []string{"[2001:db8::5]"}, "2001:db8::5"},
		{"overlong digits are malformed", []string{"6.6.6.6, 999.999.999.999"}, "127.0.0.1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got, _ := forwardedFor(proxy, "127.0.0.1:5000", tc.lines...); got != tc.want {
				t.Fatalf("want %s, got %s", tc.want, got)
			}
		})
	}
}

// A client that sends junk through a proxy which passes headers on unchanged ends up attributed to
// the proxy address. That must not share a rate-limit bucket with the proxy's own traffic.
func TestRateLimitKey_MalformedForwardedForDoesNotPoisonProxyBucket(t *testing.T) {
	proxy := []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32"), netip.MustParsePrefix("10.0.0.0/8")}

	_, healthy := forwardedFor(proxy, "127.0.0.1:5000") // no header: the proxy itself (health checks)
	if healthy != "127.0.0.1" {
		t.Fatalf("the proxy's own traffic keeps its address as key, got %q", healthy)
	}
	for _, lines := range [][]string{{"garbage"}, {"6.6.6.6, garbage"}, {"unknown"}, {","}, {"10.9.9.9"}, {"garbage", "garbage"}} {
		ip, key := forwardedFor(proxy, "127.0.0.1:5000", lines...)
		if key == healthy {
			t.Fatalf("XFF %q must not be counted in the proxy's own bucket (ip=%s key=%s)", lines, ip, key)
		}
		if ip != "127.0.0.1" && ip != "10.9.9.9" {
			t.Fatalf("XFF %q: RemoteAddr must stay a real address for the audit log, got %s", lines, ip)
		}
	}
	// A resolved client keeps its own key, even when junk sits further left.
	if _, key := forwardedFor(proxy, "127.0.0.1:5000", "garbage, 203.0.113.5"); key != "203.0.113.5" {
		t.Fatalf("a resolved client is counted under its own address, got %q", key)
	}
	// The same junk through one proxy is one shared bucket, not one per spoofed value.
	_, k1 := forwardedFor(proxy, "127.0.0.1:5000", "garbage-1")
	_, k2 := forwardedFor(proxy, "127.0.0.1:5000", "garbage-2")
	if k1 != k2 {
		t.Fatalf("junk values must not let a client mint buckets: %q vs %q", k1, k2)
	}
	// Without a trusted proxy nothing is "unresolved": the peer is the client.
	if _, key := forwardedFor(nil, "198.51.100.7:5000", "garbage"); key != "198.51.100.7" {
		t.Fatalf("direct clients are counted under their address, got %q", key)
	}
}
