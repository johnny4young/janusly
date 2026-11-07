package mcpserver

import (
	"context"
	"errors"
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
	// AllowedOrigins are browser origins allowed to call; empty refuses any
	// request that carries an Origin header.
	AllowedOrigins []string
	Logger         *slog.Logger
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
	origins := map[string]bool{}
	for _, origin := range opts.AllowedOrigins {
		origins[strings.TrimRight(origin, "/")] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		for _, name := range tokenQueryParams {
			if query.Has(name) {
				if opts.Logger != nil {
					opts.Logger.Warn("mcp request refused: credential in query string", "param", name)
				}
				http.Error(w, "credentials belong in the Authorization header, never in the URL", http.StatusBadRequest)
				return
			}
		}
		if !hostAllowed(r.Host, hosts) {
			http.Error(w, "host not allowed", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && !origins[strings.TrimRight(origin, "/")] {
			http.Error(w, "origin not allowed", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
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
