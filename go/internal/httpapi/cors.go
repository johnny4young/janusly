// Browser-facing header policy, ported from the reference's http.ts /
// server.ts: origins echo ONLY when allowlisted (API_ALLOWED_ORIGINS, same
// env, same Vite-dev defaults) alongside Allow-Credentials; the method,
// header and expose lists are the reference's verbatim; OPTIONS preflights
// answer 204 with the full dict; and an inbound X-Request-Id is honored so
// traces stitch across the stack.
package httpapi

import (
	"context"
	"net/http"
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

func resolveRequestID(inbound string) string {
	trimmed := strings.TrimSpace(inbound)
	if requestIDPattern.MatchString(trimmed) {
		return trimmed
	}
	return uuid.NewString()
}

// WithBrowserHeaders wraps a handler with the reference's CORS + request-id
// policy. Handlers read the resolved id via requestIDFrom.
func WithBrowserHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := resolveRequestID(r.Header.Get("x-request-id"))
		origin := r.Header.Get("Origin")

		headers := w.Header()
		allowed := allowedOrigins()
		allowAny := false
		for _, candidate := range allowed {
			if candidate == "*" {
				allowAny = true
			}
		}
		originAllowed := false
		if origin != "" {
			if allowAny {
				originAllowed = true
			}
			for _, candidate := range allowed {
				if candidate == origin {
					originAllowed = true
				}
			}
		}
		if originAllowed {
			headers.Set("Access-Control-Allow-Origin", origin)
			headers.Set("Access-Control-Allow-Credentials", "true")
		}
		headers.Set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
		headers.Set("Access-Control-Allow-Headers",
			"Content-Type, Authorization, x-org-id, x-user-id, x-janusly-csrf, x-request-id, Accept-Language, Last-Event-ID")
		headers.Set("Access-Control-Expose-Headers", "Content-Disposition, X-Request-Id")
		headers.Set("X-Request-Id", requestID)
		headers.Set("Vary", "Origin")

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
