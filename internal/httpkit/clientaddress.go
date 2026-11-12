package httpkit

import (
	"net"
	"net/http"
	"os"
	"strings"
)

// ClientAddress is the rate-limit key for unauthenticated surfaces: the socket
// peer, or behind JANUSLY_TRUSTED_PROXY the last X-Forwarded-For hop, the one
// the proxy itself wrote. Earlier hops come from the client and could pick
// any bucket; an unparsable hop falls back to the peer.
func ClientAddress(r *http.Request) string {
	if os.Getenv("JANUSLY_TRUSTED_PROXY") == "true" {
		hops := r.Header.Values("X-Forwarded-For")
		if len(hops) > 0 {
			last := hops[len(hops)-1]
			if ip := net.ParseIP(strings.TrimSpace(last[strings.LastIndex(last, ",")+1:])); ip != nil {
				return ip.String()
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
