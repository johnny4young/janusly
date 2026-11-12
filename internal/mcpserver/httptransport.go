package mcpserver

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"

	sdkauth "github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/agentclient"
	"github.com/johnny4young/janusly/internal/ratelimit"
)

// HTTPOptions configures the remote MCP endpoint.
type HTTPOptions struct {
	// AllowedHosts are the Host values the endpoint answers besides loopback.
	AllowedHosts []string
	// RefuseForwardedHTTP refuses requests a trusted proxy marks as plain
	// HTTP, so a bearer token never travels in clear in production.
	RefuseForwardedHTTP bool
	Logger              *slog.Logger
	// ResourceMetadataURL, when set, is named in every 401 so an OAuth client
	// can discover the authorization server.
	ResourceMetadataURL string
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
	if deps.Logger == nil {
		deps.Logger = opts.Logger
	}
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
	if deps.Limiter == nil && deps.Pool != nil {
		deps.Limiter = ratelimit.New(deps.Pool, ratelimit.Hooks{})
	}
	streamable := newStreamableHandler(deps, opts.Logger)
	// authGate already resolved the token; this only hands it to the SDK.
	verify := func(ctx context.Context, _ string, _ *http.Request) (*sdkauth.TokenInfo, error) {
		principal, _ := ctx.Value(verifiedPrincipalKey{}).(*agentclient.Principal)
		if principal == nil {
			return nil, sdkauth.ErrInvalidToken
		}
		return &sdkauth.TokenInfo{
			UserID: principal.ActorID(), Expiration: principal.ExpiresAt,
			Extra: map[string]any{principalExtraKey: principal},
		}, nil
	}
	authenticated := challenge(opts.ResourceMetadataURL, authGate(deps, resolver, opts.Logger,
		sdkauth.RequireBearerToken(verify, nil)(refuseBatches(streamable))))
	protected := http.NewCrossOriginProtection().Handler(authenticated)
	return guardHTTP(protected, opts)
}

func newStreamableHandler(deps Deps, logger *slog.Logger) http.Handler {
	server := NewServer(deps)
	server.AddReceivingMiddleware(refuseLongLived)
	return mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server },
		&mcp.StreamableHTTPOptions{
			Stateless: true, JSONResponse: true, MaxRequestBodyBytes: maxMCPRequestBytes, Logger: logger,
			// guardHTTP's host allowlist replaces this check, which would refuse
			// a reverse proxy on the same host.
			DisableLocalhostProtection: true,
		})
}

// refuseLongLived rejects the subscription stream: they skip the tool guard and
// would outlive the token check made when the request started.
func refuseLongLived(next mcp.MethodHandler) mcp.MethodHandler {
	return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
		if method == "subscriptions/listen" {
			return nil, &jsonrpc.Error{Code: jsonrpc.CodeMethodNotFound, Message: method + " is not supported"}
		}
		return next(ctx, method, req)
	}
}

var errVerificationUnavailable = errors.New("token verification is temporarily unavailable")

// challenge adds the bearer challenge to every 401, which the SDK omits
// without OAuth metadata.
func challenge(resourceMetadataURL string, next http.Handler) http.Handler {
	header := `Bearer realm="janusly"`
	if resourceMetadataURL != "" {
		header += `, resource_metadata="` + resourceMetadataURL + `"`
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(&challengeWriter{ResponseWriter: w, header: header}, r)
	})
}

type challengeWriter struct {
	http.ResponseWriter
	header string
}

func (w *challengeWriter) WriteHeader(status int) {
	if status == http.StatusUnauthorized {
		w.Header().Set("WWW-Authenticate", w.header)
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *challengeWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *challengeWriter) Flush() {
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

// GuardAgentHTTP applies the transport rules every agent-token endpoint
// shares: no credentials in the URL, https behind a proxy, an allowed Host and
// no browser origins.
func GuardAgentHTTP(next http.Handler, opts HTTPOptions) http.Handler { return guardHTTP(next, opts) }

func guardHTTP(next http.Handler, opts HTTPOptions) http.Handler {
	hosts := map[string]bool{}
	for _, host := range opts.AllowedHosts {
		hosts[strings.ToLower(host)] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if name, found := tokenInQuery(r); found {
			if opts.Logger != nil {
				opts.Logger.Warn("agent request refused: credential in query string", "param", name)
			}
			http.Error(w, "credentials belong in the Authorization header, never in the URL", http.StatusBadRequest)
			return
		}
		if opts.RefuseForwardedHTTP && forwardedPlainHTTP(r) {
			http.Error(w, "agent endpoints require https", http.StatusForbidden)
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
		next.ServeHTTP(w, r)
	})
}

// refuseBatches runs after authentication so an anonymous caller cannot make
// the server buffer a request body.
func refuseBatches(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && isBatch(w, r) {
			http.Error(w, "JSON-RPC batches are not accepted; send one message per request", http.StatusBadRequest)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// forwardedPlainHTTP checks every hop, so a client-supplied "https" ahead of
// the proxy's own value cannot mask a plain HTTP leg.
func forwardedPlainHTTP(r *http.Request) bool {
	for _, value := range r.Header.Values("X-Forwarded-Proto") {
		for proto := range strings.SplitSeq(value, ",") {
			if strings.EqualFold(strings.TrimSpace(proto), "http") {
				return true
			}
		}
	}
	return false
}

// tokenInQuery also scans the raw query, because url.ParseQuery drops pairs it
// cannot parse and a token may sit in a key or mid-value.
func tokenInQuery(r *http.Request) (string, bool) {
	raw := r.URL.RawQuery
	if unescaped, err := url.QueryUnescape(raw); err == nil {
		raw = unescaped
	}
	if strings.Contains(raw, agentclient.TokenPrefix) {
		return "(agent token)", true
	}
	for name := range r.URL.Query() {
		if slices.ContainsFunc(tokenQueryParams, func(refused string) bool { return strings.EqualFold(name, refused) }) {
			return name, true
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
