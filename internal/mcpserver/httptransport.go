package mcpserver

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"

	sdkauth "github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/agentclient"
)

// HTTPOptions configures the remote MCP endpoint.
type HTTPOptions struct {
	// AllowedHosts are the Host values the endpoint answers besides loopback.
	AllowedHosts []string
	// RefuseForwardedHTTP refuses requests a trusted proxy marks as plain
	// HTTP, so a bearer token never travels in clear in production.
	RefuseForwardedHTTP bool
	Logger              *slog.Logger
}

const principalExtraKey = "janusly.principal"

// tokenQueryParams are refused outright: a token in a URL lands in proxy logs
// and browser history.
var tokenQueryParams = []string{"access_token", "token", "api_key", "key", "auth", "authorization"}

// NewHTTPHandler serves MCP over Streamable HTTP, stateless and in JSON mode,
// for agent client bearer tokens only.
func NewHTTPHandler(deps Deps, opts HTTPOptions) http.Handler {
	resolver := agentclient.Resolver{Pool: deps.Pool}
	deps.Transport = "http"
	deps.ResolveActor = func(_ context.Context, req mcp.Request) (*agentclient.Principal, error) {
		extra := req.GetExtra()
		if extra == nil || extra.TokenInfo == nil {
			return nil, agentclient.ErrInvalidToken
		}
		principal, _ := extra.TokenInfo.Extra[principalExtraKey].(*agentclient.Principal)
		if principal == nil {
			return nil, agentclient.ErrInvalidToken
		}
		return principal, nil
	}
	server := NewServer(deps)
	streamable := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server },
		&mcp.StreamableHTTPOptions{
			Stateless: true, JSONResponse: true, MaxRequestBodyBytes: maxMCPRequestBytes, Logger: opts.Logger,
			// guardHTTP's host allowlist replaces this check, which would refuse
			// a reverse proxy on the same host.
			DisableLocalhostProtection: true,
		})
	verify := func(ctx context.Context, token string, _ *http.Request) (*sdkauth.TokenInfo, error) {
		principal, err := resolver.Resolve(ctx, token)
		if errors.Is(err, agentclient.ErrInvalidToken) {
			return nil, sdkauth.ErrInvalidToken
		}
		if err != nil {
			// The SDK echoes this text; never let a store error reach the wire.
			if opts.Logger != nil {
				opts.Logger.Error("mcp token verification failed", "error", err)
			}
			return nil, errVerificationUnavailable
		}
		return &sdkauth.TokenInfo{
			UserID: principal.ActorID(), Expiration: principal.ExpiresAt,
			Extra: map[string]any{principalExtraKey: principal},
		}, nil
	}
	authenticated := challenge(sdkauth.RequireBearerToken(verify, nil)(streamable))
	protected := http.NewCrossOriginProtection().Handler(authenticated)
	return guardHTTP(protected, opts)
}

var errVerificationUnavailable = errors.New("token verification is temporarily unavailable")

// challenge adds the bearer challenge to every 401, which the SDK omits
// without OAuth metadata.
func challenge(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(&challengeWriter{ResponseWriter: w}, r)
	})
}

type challengeWriter struct{ http.ResponseWriter }

func (w *challengeWriter) WriteHeader(status int) {
	if status == http.StatusUnauthorized {
		w.Header().Set("WWW-Authenticate", `Bearer realm="janusly"`)
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *challengeWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *challengeWriter) Flush() {
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func guardHTTP(next http.Handler, opts HTTPOptions) http.Handler {
	hosts := map[string]bool{}
	for _, host := range opts.AllowedHosts {
		hosts[strings.ToLower(host)] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if name, found := tokenInQuery(r); found {
			if opts.Logger != nil {
				opts.Logger.Warn("mcp request refused: credential in query string", "param", name)
			}
			http.Error(w, "credentials belong in the Authorization header, never in the URL", http.StatusBadRequest)
			return
		}
		if opts.RefuseForwardedHTTP && strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "http") {
			http.Error(w, "remote MCP requires https", http.StatusForbidden)
			return
		}
		if !hostAllowed(r.Host, hosts) {
			http.Error(w, "host not allowed", http.StatusForbidden)
			return
		}
		// Browsers are not supported callers: native clients send no Origin.
		if r.Header.Get("Origin") != "" {
			http.Error(w, "browser origins are not allowed", http.StatusForbidden)
			return
		}
		if r.Method == http.MethodPost && isBatch(w, r) {
			http.Error(w, "JSON-RPC batches are not accepted; send one message per request", http.StatusBadRequest)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func tokenInQuery(r *http.Request) (string, bool) {
	for name, values := range r.URL.Query() {
		for _, refused := range tokenQueryParams {
			if strings.EqualFold(name, refused) {
				return name, true
			}
		}
		for _, value := range values {
			if agentclient.LooksLikeToken(value) {
				return name, true
			}
		}
	}
	return "", false
}

// isBatch peeks at the body and puts it back. A batch would fan one request
// out into thousands of concurrent tool calls, each audited.
func isBatch(w http.ResponseWriter, r *http.Request) bool {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxMCPRequestBytes+1))
	r.Body = io.NopCloser(bytes.NewReader(body))
	if err != nil {
		return false
	}
	trimmed := bytes.TrimLeft(body, " \t\r\n")
	return len(trimmed) > 0 && trimmed[0] == '['
}

func hostAllowed(hostport string, allowed map[string]bool) bool {
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	host = strings.ToLower(strings.Trim(host, "[]"))
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return true
	}
	return allowed[host]
}
