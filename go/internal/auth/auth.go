// Package auth is the request-authentication entry point, ported from the
// reference resolver (apps/api/src/auth.ts): a provider CHAIN where the
// first extractor that yields a principal wins, and membership resolution
// where the grant IS the org_members row — an org hint (header or claim)
// is a scope selector, never authority.
//
// Modes in chain order (the pilot's subset of the reference's chain —
// the janusly-session SSO provider stays with the reference for now):
//  1. supabase       Authorization: Bearer <jwt>, verified against the
//     Supabase Auth API when SUPABASE_URL is configured.
//  2. service-token  constant-time bearer match; org/user from headers;
//     NO implicit admin.
//  3. dev-headers    x-org-id + x-user-id; auto-allowed only when
//     Supabase is unset AND the environment is not
//     production (explicit ALLOW_DEV_AUTH_HEADERS=true
//     otherwise).
//
// Invariants inherited verbatim:
//   - Service-token compare is constant time (never ==).
//   - Supabase requests hardcode source "web" — a browser cannot
//     self-declare MCP.
//   - Route handlers consume Context only; ProviderPrincipal stays
//     package-private.
package auth

import (
	"context"
	"crypto/subtle"
	"net/http"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/go/internal/store"
)

// Mode records which provider extracted the request.
type Mode string

const (
	ModeSupabase     Mode = "supabase"
	ModeServiceToken Mode = "service-token"
	ModeDevHeaders   Mode = "dev-headers"
)

// Source is the caller surface label — informational ONLY, never an
// authorization gate (real consent gates read server-controlled state).
type Source string

const (
	SourceWeb     Source = "web"
	SourceMcp     Source = "mcp"
	SourceService Source = "service"
	SourceDev     Source = "dev"
)

// Context is the resolved authentication handed to each route.
type Context struct {
	OrgID              string
	UserID             string
	Mode               Mode
	Source             Source
	ServiceTokenSuffix string
	// MembershipRole is the org_members row's role when one exists; empty
	// for the dev-headers admin auto-grant case (permissions layer decides).
	MembershipRole string
}

// principal is the untrusted carrier of provider-supplied claims.
type principal struct {
	providerName       Mode
	providerUserID     string
	providerOrgHint    string
	declaredSource     Source
	serviceTokenSuffix string
}

// Resolver owns the provider chain and the membership resolution.
type Resolver struct {
	pool *pgxpool.Pool
	// Seams for tests and for the Supabase HTTP verifier (T-070).
	supabaseURL     string
	supabaseKey     string
	serviceToken    string
	allowDevHeaders bool
	verifySupabase  func(ctx context.Context, token string) (userID string, email string, ok bool)
}

// Config mirrors the reference's boot-time gate inputs.
type Config struct {
	SupabaseURL     string
	SupabaseKey     string
	ServiceToken    string
	Production      bool
	AllowDevHeaders bool
}

// ConfigFromEnv reads the reference's environment contract.
func ConfigFromEnv() Config {
	return Config{
		SupabaseURL:     os.Getenv("SUPABASE_URL"),
		SupabaseKey:     os.Getenv("SUPABASE_SERVICE_ROLE_KEY"),
		ServiceToken:    os.Getenv("JANUSLY_API_SERVICE_TOKEN"),
		Production:      os.Getenv("JANUSLY_GO_ENV") == "production",
		AllowDevHeaders: os.Getenv("ALLOW_DEV_AUTH_HEADERS") == "true",
	}
}

// BootError is the reference's fail-fast: production without Supabase and
// without the explicit dev-headers override must refuse to start.
func (c Config) BootError() error {
	if c.SupabaseURL == "" && c.Production && !c.AllowDevHeaders {
		return errProductionAuth
	}
	return nil
}

type authBootError struct{}

func (authBootError) Error() string {
	return "Production requires Supabase auth (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) or explicit ALLOW_DEV_AUTH_HEADERS=true."
}

var errProductionAuth = authBootError{}

// NewResolver builds the chain over the pool.
func NewResolver(pool *pgxpool.Pool, cfg Config) *Resolver {
	allowDev := cfg.AllowDevHeaders || (cfg.SupabaseURL == "" && !cfg.Production)
	r := &Resolver{
		pool:            pool,
		supabaseURL:     cfg.SupabaseURL,
		supabaseKey:     cfg.SupabaseKey,
		serviceToken:    cfg.ServiceToken,
		allowDevHeaders: allowDev,
	}
	r.verifySupabase = r.verifySupabaseHTTP
	return r
}

func constantTimeBearerMatch(header, expected string) bool {
	if header == "" || expected == "" {
		return false
	}
	want := "Bearer " + expected
	if len(header) != len(want) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(header), []byte(want)) == 1
}

func declaredSource(r *http.Request, fallback Source) Source {
	if strings.EqualFold(r.Header.Get("x-janusly-source"), "mcp") {
		return SourceMcp
	}
	return fallback
}

// extract runs the chain in the reference's priority order.
func (rv *Resolver) extract(ctx context.Context, r *http.Request) *principal {
	// 1. Supabase JWT.
	if rv.supabaseURL != "" {
		if header := r.Header.Get("Authorization"); strings.HasPrefix(header, "Bearer ") &&
			!constantTimeBearerMatch(header, rv.serviceToken) {
			token := strings.TrimPrefix(header, "Bearer ")
			if userID, _, ok := rv.verifySupabase(ctx, token); ok {
				return &principal{
					providerName:    ModeSupabase,
					providerUserID:  userID,
					providerOrgHint: strings.TrimSpace(r.Header.Get("x-org-id")),
					// Hardcoded: a browser cannot self-declare MCP.
					declaredSource: SourceWeb,
				}
			}
			return nil // a Bearer that fails verification never falls through
		}
	}
	// 2. Service token.
	if rv.serviceToken != "" && constantTimeBearerMatch(r.Header.Get("Authorization"), rv.serviceToken) {
		userID := strings.TrimSpace(r.Header.Get("x-user-id"))
		if userID == "" {
			userID = "service"
		}
		return &principal{
			providerName:       ModeServiceToken,
			providerUserID:     userID,
			providerOrgHint:    strings.TrimSpace(r.Header.Get("x-org-id")),
			declaredSource:     declaredSource(r, SourceService),
			serviceTokenSuffix: rv.serviceToken[len(rv.serviceToken)-min(4, len(rv.serviceToken)):],
		}
	}
	// 3. Dev headers.
	if rv.allowDevHeaders {
		orgID := strings.TrimSpace(r.Header.Get("x-org-id"))
		userID := strings.TrimSpace(r.Header.Get("x-user-id"))
		if orgID != "" && userID != "" {
			return &principal{
				providerName:    ModeDevHeaders,
				providerUserID:  userID,
				providerOrgHint: orgID,
				declaredSource:  declaredSource(r, SourceDev),
			}
		}
	}
	return nil
}

// Resolve maps a request to a Context or nil (the dispatcher 401s).
func (rv *Resolver) Resolve(ctx context.Context, r *http.Request) (*Context, error) {
	p := rv.extract(ctx, r)
	if p == nil {
		return nil, nil
	}
	q := store.New(rv.pool)
	switch p.providerName {
	case ModeSupabase:
		return rv.resolveSupabaseMembership(ctx, q, p)
	case ModeServiceToken:
		orgID := p.providerOrgHint
		if orgID == "" {
			orgID = "default"
		}
		role := ""
		if membership, err := q.GetOrgMembership(ctx, store.GetOrgMembershipParams{
			OrgID: orgID, UserID: p.providerUserID,
		}); err == nil {
			role = membership.Role
		} else if !errorsIsNoRows(err) {
			return nil, err
		}
		return &Context{
			OrgID: orgID, UserID: p.providerUserID, Mode: ModeServiceToken,
			Source: p.declaredSource, ServiceTokenSuffix: p.serviceTokenSuffix,
			MembershipRole: role,
		}, nil
	default: // dev-headers
		role := ""
		if membership, err := q.GetOrgMembership(ctx, store.GetOrgMembershipParams{
			OrgID: p.providerOrgHint, UserID: p.providerUserID,
		}); err == nil {
			role = membership.Role
		} else if !errorsIsNoRows(err) {
			return nil, err
		}
		return &Context{
			OrgID: p.providerOrgHint, UserID: p.providerUserID,
			Mode: ModeDevHeaders, Source: p.declaredSource,
			MembershipRole: role,
		}, nil
	}
}

// resolveSupabaseMembership: the security-relevant branch — the hint is a
// SCOPE selector; the grant is the org_members row. The pilot ports steps
// 1 (direct match), 3 (hint-less single membership) and 4 (hint-less
// multiple → nil); the provisioning paths (legacy backfill, invitations,
// verified domains, SSO JIT) stay with the reference for now.
func (rv *Resolver) resolveSupabaseMembership(ctx context.Context, q *store.Queries, p *principal) (*Context, error) {
	if p.providerOrgHint != "" {
		membership, err := q.GetOrgMembership(ctx, store.GetOrgMembershipParams{
			OrgID: p.providerOrgHint, UserID: p.providerUserID,
		})
		if err == nil {
			return &Context{
				OrgID: p.providerOrgHint, UserID: p.providerUserID,
				Mode: ModeSupabase, Source: SourceWeb, MembershipRole: membership.Role,
			}, nil
		}
		if !errorsIsNoRows(err) {
			return nil, err
		}
		return nil, nil // hint without a grant fails closed
	}
	memberships, err := q.ListOrgMembershipsForUser(ctx, p.providerUserID)
	if err != nil {
		return nil, err
	}
	if len(memberships) == 1 {
		return &Context{
			OrgID: memberships[0].OrgID, UserID: p.providerUserID,
			Mode: ModeSupabase, Source: SourceWeb, MembershipRole: memberships[0].Role,
		}, nil
	}
	return nil, nil // zero or ambiguous — force x-org-id
}

func errorsIsNoRows(err error) bool {
	return err == pgx.ErrNoRows || (err != nil && err.Error() == pgx.ErrNoRows.Error())
}

// verifySupabaseHTTP validates the access token against the Supabase Auth
// API — the same network validation the reference performs through its
// SDK (supabase.auth.getUser). Full implementation lands with the
// supabase-mode ticket; the seam exists so tests can inject verifiers.
func (rv *Resolver) verifySupabaseHTTP(ctx context.Context, token string) (string, string, bool) {
	return verifySupabaseUser(ctx, rv.supabaseURL, rv.supabaseKey, token)
}
