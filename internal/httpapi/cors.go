// Browser-facing header policy, implements the contract's http.ts /
// server.ts: origins echo ONLY when allowlisted (API_ALLOWED_ORIGINS, same
// env, same Vite-dev defaults) alongside Allow-Credentials; the method,
// header and expose lists are the contract's verbatim; OPTIONS preflights
// answer 204 with the full dict; and an inbound X-Request-Id is honored so
// traces stitch across the stack.
package httpapi

import (
	"context"
	"github.com/johnny4young/janusly/internal/config"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"

	"github.com/google/uuid"
)

const defaultAllowedOrigins = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174"

type requestIDKey struct{}

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

func allowedOrigins() []string {
	configured := os.Getenv("API_ALLOWED_ORIGINS")
	if configured == "" {
		configured = defaultAllowedOrigins
	}
	parts := strings.Split(configured, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func isAllowedRequestOrigin(origin string) bool {
	if origin == "" {
		return false
	}
	production := config.IsProduction(nil)
	for _, candidate := range allowedOrigins() {
		if candidate == origin || (candidate == "*" && !production) {
			return true
		}
	}
	return false
}

func resolveRequestID(inbound string) string {
	trimmed := strings.TrimSpace(inbound)
	if requestIDPattern.MatchString(trimmed) {
		return trimmed
	}
	return uuid.NewString()
}

func browserConnectSources() string {
	sources := []string{"'self'", "https:", "wss:"}
	seen := map[string]bool{"'self'": true, "https:": true, "wss:": true}
	for raw := range strings.SplitSeq(os.Getenv("JANUSLY_BROWSER_CONNECT_ORIGINS"), ",") {
		candidate := strings.TrimSpace(raw)
		if candidate == "" {
			continue
		}
		parsed, err := url.Parse(candidate)
		if err != nil || parsed.Scheme != "http" || parsed.Host == "" || parsed.User != nil ||
			(parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
			continue
		}
		hostname := strings.ToLower(parsed.Hostname())
		ip := net.ParseIP(hostname)
		if hostname != "localhost" && (ip == nil || !ip.IsLoopback()) {
			continue
		}
		origin := parsed.Scheme + "://" + parsed.Host
		if !seen[origin] {
			sources = append(sources, origin)
			seen[origin] = true
		}
	}
	return strings.Join(sources, " ")
}

// WithBrowserHeaders wraps a handler with the contract's CORS + request-id
// policy. Handlers read the resolved id via requestIDFrom.
func WithBrowserHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := resolveRequestID(r.Header.Get("x-request-id"))
		origin := r.Header.Get("Origin")

		headers := w.Header()
		originAllowed := isAllowedRequestOrigin(origin)
		if originAllowed {
			headers.Set("Access-Control-Allow-Origin", origin)
			headers.Set("Access-Control-Allow-Credentials", "true")
		}
		headers.Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
		headers.Set("Access-Control-Allow-Headers",
			"Content-Type, Authorization, x-org-id, x-user-id, x-janusly-csrf, x-request-id, Accept-Language, Last-Event-ID")
		headers.Set("Access-Control-Expose-Headers", "Content-Disposition, X-Request-Id")
		headers.Set("X-Request-Id", requestID)
		headers.Set("Vary", "Origin")
		headers.Set("X-Content-Type-Options", "nosniff")
		headers.Set("X-Frame-Options", "DENY")
		headers.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		headers.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		headers.Set("Content-Security-Policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src "+browserConnectSources()+"; form-action 'self'")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r.WithContext(
			context.WithValue(r.Context(), requestIDKey{}, requestID)))
	})
}

// requestIDFrom returns the middleware-resolved id, or a fresh one for
// callers outside the wrapped handler (tests hitting handlers directly).
func requestIDFrom(r *http.Request) string {
	if id, ok := r.Context().Value(requestIDKey{}).(string); ok {
		return id
	}
	return uuid.NewString()
}
