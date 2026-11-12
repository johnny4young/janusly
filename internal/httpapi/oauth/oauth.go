// Package oauth is the OAuth 2.1 authorization server for remote MCP. A grant
// is an ordinary agent client: its authority stays the capability ceiling
// intersected with its creator's live permissions on every call.
package oauth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/agentclient"
	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/httpkit"
	"github.com/johnny4young/janusly/internal/ratelimit"
)

const (
	// AccessTTL is an access token's life; the grant itself lives as long as
	// its agent client, and refreshing never extends that.
	AccessTTL  = 15 * time.Minute
	codeTTL    = 60 * time.Second
	requestTTL = 10 * time.Minute
	// UnusedClientTTL is how long a registration nobody used is kept.
	UnusedClientTTL = 24 * time.Hour
	// maxUnusedClients bounds what unauthenticated registration can store.
	maxUnusedClients = 1000
	maxFormBytes     = 8 << 10

	codePrefix    = "jly_code_"
	refreshPrefix = "jly_refresh_"
	scopePrefix   = "janusly:"

	codeReuseAction    = "oauth.code_reused"
	refreshReuseAction = "oauth.refresh_reused"
)

func init() {
	audit.RegisterRuntimeAction(codeReuseAction)
	audit.RegisterRuntimeAction(refreshReuseAction)
}

// Grantable are the capabilities OAuth can carry. report is absent on
// purpose: the hooks bridge has no browser and uses a static token.
var Grantable = []agentclient.Capability{
	agentclient.CapabilityRead, agentclient.CapabilityPropose, agentclient.CapabilityTest,
	agentclient.CapabilityPublish, agentclient.CapabilityOperate,
}

var (
	registerLimit  = ratelimit.Options{Name: "oauth.register", Max: 10, Window: time.Hour}
	authorizeLimit = ratelimit.Options{Name: "oauth.authorize", Max: 30, Window: time.Minute}
	tokenLimit     = ratelimit.Options{Name: "oauth.token", Max: 60, Window: time.Minute}
)

// Deps are the shared API dependencies. Issuer is the public base URL.
type Deps struct {
	Audit   audit.Writer
	Pool    *pgxpool.Pool
	Limiter *ratelimit.Limiter
	Routes  httpkit.Registrar
	Issuer  string
	Logger  *slog.Logger
	Now     func() time.Time
}

type service struct {
	audit   audit.Writer
	pool    *pgxpool.Pool
	limiter *ratelimit.Limiter
	issuer  string
	logger  *slog.Logger
	now     func() time.Time
}

// Resource is the only audience a grant can name.
func Resource(issuer string) string { return issuer + "/mcp" }

// ResourceMetadataURL is what a 401 from /mcp points an OAuth client at.
func ResourceMetadataURL(issuer string) string {
	return issuer + "/.well-known/oauth-protected-resource/mcp"
}

// Mount registers the OAuth endpoints. Without an issuer only the consent
// routes exist, and no request can reach them.
func Mount(mux *http.ServeMux, deps Deps) {
	s := &service{audit: deps.Audit, pool: deps.Pool, limiter: deps.Limiter, issuer: deps.Issuer, logger: deps.Logger, now: deps.Now}
	if s.now == nil {
		s.now = time.Now
	}
	if s.logger == nil {
		s.logger = slog.Default()
	}
	if deps.Issuer != "" {
		mux.HandleFunc("GET /.well-known/oauth-protected-resource", s.resourceMetadata)
		mux.HandleFunc("GET /.well-known/oauth-protected-resource/mcp", s.resourceMetadata)
		mux.HandleFunc("GET /.well-known/oauth-authorization-server", s.serverMetadata)
		mux.HandleFunc("POST /oauth/register", s.register)
		mux.HandleFunc("GET /oauth/authorize", s.authorize)
		mux.HandleFunc("POST /oauth/token", s.token)
	}

	// Consent creates an agent client, so it needs what creating one needs.
	read := httpkit.Gate{Role: auth.RoleEditor, Permission: "agents.write"}
	deps.Routes.Route(mux, "GET /oauth/requests/{requestId}", read, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		w.Header().Set("Cache-Control", "no-store")
		httpkit.WriteUnversioned(w, s.consentView(r, rc))
	})
	deps.Routes.Route(mux, "POST /oauth/requests/{requestId}/decision", read, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		w.Header().Set("Cache-Control", "no-store")
		httpkit.WriteUnversioned(w, s.decide(r, rc))
	})
}

func scopeNames() []string {
	out := make([]string, 0, len(Grantable))
	for _, capability := range Grantable {
		out = append(out, scopePrefix+string(capability))
	}
	return out
}

func (s *service) resourceMetadata(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"resource": Resource(s.issuer), "authorization_servers": []string{s.issuer},
		"scopes_supported": scopeNames(), "bearer_methods_supported": []string{"header"},
		"resource_name": "Janusly",
	})
}

func (s *service) serverMetadata(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                         s.issuer,
		"authorization_endpoint":                         s.issuer + "/oauth/authorize",
		"token_endpoint":                                 s.issuer + "/oauth/token",
		"registration_endpoint":                          s.issuer + "/oauth/register",
		"scopes_supported":                               scopeNames(),
		"response_types_supported":                       []string{"code"},
		"grant_types_supported":                          []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":               []string{"S256"},
		"token_endpoint_auth_methods_supported":          []string{"none"},
		"authorization_response_iss_parameter_supported": true,
	})
}

// limited counts one unauthenticated request per client address.
func (s *service) limited(w http.ResponseWriter, r *http.Request, opts ratelimit.Options) bool {
	if s.limiter == nil {
		return false
	}
	var limit *ratelimit.LimitError
	if err := s.limiter.Enforce(r.Context(), "ip:"+httpkit.ClientAddress(r), opts); err != nil && asLimit(err, &limit) {
		w.Header().Set("Retry-After", itoa(limit.RetryAfterSec))
		oauthError(w, http.StatusTooManyRequests, "slow_down", "too many requests; retry later")
		return true
	}
	return false
}

// oauthError writes an RFC 6749 error object. It never echoes input.
func oauthError(w http.ResponseWriter, status int, code, description string) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, status, map[string]any{"error": code, "error_description": description})
}

/* ------------------------------ redirect URIs ---------------------------- */

func loopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// validRedirect accepts https anywhere and http only on loopback (RFC 8252).
// No wildcards, fragments or credentials, and no private schemes yet.
func validRedirect(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || len(raw) > 2000 || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" || strings.Contains(raw, "#") {
		return false
	}
	switch parsed.Scheme {
	case "https":
		return true
	case "http":
		return loopbackHost(parsed.Hostname())
	}
	return false
}

// redirectMatches is exact, except that a loopback redirect may use any port.
func redirectMatches(registered []string, presented string) bool {
	if slices.Contains(registered, presented) {
		return true
	}
	got, err := url.Parse(presented)
	if err != nil || got.Scheme != "http" || !loopbackHost(got.Hostname()) || !validRedirect(presented) {
		return false
	}
	for _, candidate := range registered {
		want, err := url.Parse(candidate)
		if err == nil && want.Scheme == "http" && want.Hostname() == got.Hostname() &&
			want.Path == got.Path && want.RawQuery == got.RawQuery {
			return true
		}
	}
	return false
}

/* ------------------------------- secrets -------------------------------- */

func newSecret(prefix string) (string, []byte, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, err
	}
	secret := prefix + base64.RawURLEncoding.EncodeToString(raw)
	return secret, digest(secret), nil
}

func digest(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

var (
	challengePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	verifierPattern  = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)
)

func pkceMatches(verifier, challenge string) bool {
	if !verifierPattern.MatchString(verifier) {
		return false
	}
	sum := sha256.Sum256([]byte(verifier))
	return subtle.ConstantTimeCompare([]byte(base64.RawURLEncoding.EncodeToString(sum[:])), []byte(challenge)) == 1
}

/* -------------------------------- scopes -------------------------------- */

// parseScopes maps the scope parameter to capabilities. Empty means read;
// read is implied by every other scope.
func parseScopes(raw string) ([]string, bool) {
	out := []string{string(agentclient.CapabilityRead)}
	for scope := range strings.FieldsSeq(raw) {
		name, ok := strings.CutPrefix(scope, scopePrefix)
		if !ok || !slices.Contains(Grantable, agentclient.Capability(name)) {
			return nil, false
		}
		if !slices.Contains(out, name) {
			out = append(out, name)
		}
	}
	return out, true
}

func scopeString(capabilities []string) string {
	parts := make([]string, 0, len(capabilities))
	for _, capability := range capabilities {
		if slices.Contains(Grantable, agentclient.Capability(capability)) {
			parts = append(parts, scopePrefix+capability)
		}
	}
	return strings.Join(parts, " ")
}
