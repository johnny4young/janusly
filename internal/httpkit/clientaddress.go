package httpkit

import (
	"net"
	"net/http"
	"os"
	"strings"
)

// ClientAddress is the rate-limit key for unauthenticated surfaces. It is the
// socket peer unless the deployment declares a trusted proxy in front of the
// process, in which case the first X-Forwarded-For hop is the client; trusting
// that header without the flag would let any caller pick its own bucket.
func ClientAddress(r *http.Request) string {
	if os.Getenv("JANUSLY_TRUSTED_PROXY") == "true" {
		if forwarded := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0]); forwarded != "" {
			return forwarded
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
