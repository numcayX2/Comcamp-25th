package middleware

import (
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
				if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
					hops := strings.Split(xff, ",")
					for i := len(hops) - 1; i >= 0; i-- {
						hop, valid := parseAddr(strings.TrimSpace(hops[i]))
						if !valid {
							break
						}
						client = hop
						if !isTrusted(hop) {
							break
						}
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
