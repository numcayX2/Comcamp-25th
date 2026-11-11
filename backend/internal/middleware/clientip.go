package middleware

import (
	"context"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// ClientIP replaces chi's RealIP, which trusts X-Forwarded-For from anyone and so lets a client
// pick the IP that rate limits and audit logs see. Forwarding headers are honoured only when the
// TCP peer is one of trustedProxies; the client is then the right-most address in
// X-Forwarded-For that is not itself a trusted proxy.
//
// X-Forwarded-For may arrive as several header lines (a proxy that appends its own line instead of
// extending the first). All of them are read, in order, as one list, so a client cannot hide behind
// the first line it sent while the proxy's line is ignored.
//
// Walking the list from the right stops at the first malformed hop: nothing to its left was written
// by a proxy we trust, so it is never used. If that leaves only a trusted proxy address (a client
// that sent junk to a proxy which forwards headers unchanged), the request is marked unresolved and
// RateLimitKey counts it under its own bucket rather than the proxy's, so junk headers cannot use
// up the allowance of the proxy's own traffic.
//
// After this middleware r.RemoteAddr holds the bare client IP (no port).
func ClientIP(trustedProxies []netip.Prefix) func(http.Handler) http.Handler {
	isTrusted := func(a netip.Addr) bool {
		for _, p := range trustedProxies {
			if p.Contains(a) {
				return true
			}
		}
		return false
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			peer, ok := parseAddr(r.RemoteAddr)
			client := peer
			if ok && len(trustedProxies) > 0 && isTrusted(peer) {
				if xff := strings.Join(r.Header.Values("X-Forwarded-For"), ","); strings.TrimSpace(xff) != "" {
					hops := strings.Split(xff, ",")
					resolved := false
					for i := len(hops) - 1; i >= 0; i-- {
						hop, valid := parseAddr(strings.TrimSpace(hops[i]))
						if !valid {
							break
						}
						client = hop
						if !isTrusted(hop) {
							resolved = true
							break
						}
					}
					if !resolved && isTrusted(client) {
						// Junk (or only trusted hops) in the header and no client address behind it.
						r = r.WithContext(context.WithValue(r.Context(), unresolvedKey{}, true))
					}
				} else if xr, valid := parseAddr(strings.TrimSpace(r.Header.Get("X-Real-IP"))); valid {
					client = xr
				}
			}
			if ok {
				r.RemoteAddr = client.String()
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RemoteIP returns the client IP as a string (works with or without ClientIP having run).
func RemoteIP(r *http.Request) string {
	if a, ok := parseAddr(r.RemoteAddr); ok {
		return a.String()
	}
	return r.RemoteAddr
}

// RateLimitKey is the key the rate limiters count a request under. IPv4 addresses are used as they
// are. An IPv6 address is reduced to its /64 prefix: a single subscriber normally owns a whole /64
// (often a /48 or /56), so counting per /128 would let one client rotate through 2^64 addresses
// and never hit a limit, and would also let it fill the limiter's table with distinct keys.
// Zones are dropped and IPv4-mapped IPv6 addresses count as the IPv4 address they carry.
func RateLimitKey(r *http.Request) string {
	key := r.RemoteAddr
	if addr, ok := parseAddr(r.RemoteAddr); ok {
		key = addr.String()
		if addr.Is6() {
			key = netip.PrefixFrom(addr, 64).Masked().Addr().String()
		}
	}
	if unresolved, _ := r.Context().Value(unresolvedKey{}).(bool); unresolved {
		return "unresolved-xff:" + key
	}
	return key
}

// unresolvedKey marks a request whose X-Forwarded-For held no usable client address, see ClientIP.
type unresolvedKey struct{}

func parseAddr(s string) (netip.Addr, bool) {
	if s == "" {
		return netip.Addr{}, false
	}
	if host, _, err := net.SplitHostPort(s); err == nil {
		s = host
	}
	a, err := netip.ParseAddr(strings.Trim(s, "[]"))
	if err != nil {
		return netip.Addr{}, false
	}
	return a.Unmap(), true
}
