// Package auth is the request-authentication entry point, implements the
// reference resolver (the API contract): a provider CHAIN where the
// first extractor that yields a principal wins, and membership resolution
// where the grant IS the org_members row — an org hint (header or claim)
// is a scope selector, never authority.
//
// Modes in chain order:
//  1. janusly-session signed opaque cookie resolved through a live,
//     unrevoked auth_sessions row.
//  2. supabase       Authorization: Bearer <jwt>, verified against the
//     Supabase Auth API when SUPABASE_URL is configured.
//  3. service-token  constant-time bearer match; org/user from headers;
//     NO implicit admin.
//  4. dev-headers    x-org-id + x-user-id; auto-allowed only when
//     Supabase is unset AND the environment is not
//     production (explicit ALLOW_DEV_AUTH_HEADERS=true
//     otherwise).
//
// Invariants inherited verbatim:
//   - Service-token compare is constant time (never ==).
//   - Supabase requests hardcode source "web" — a browser cannot
//     self-declare MCP.
//   - Tenant routes consume Context; bootstrap routes may consume Identity;
//     principal stays package-private.
package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"github.com/johnny4young/janusly/internal/config"
	"net/http"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/browsersession"
	"github.com/johnny4young/janusly/internal/store"
)

// Mode records which provider extracted the request.
type Mode string

const (
	ModeJanuslySession Mode = "janusly-session"
	ModeSupabase       Mode = "supabase"
	ModeServiceToken   Mode = "service-token"
	ModeDevHeaders     Mode = "dev-headers"
)

// Source is the caller surface label — informational ONLY, never an
// authorization gate (real consent gates read server-controlled state).
type Source string

const (
	SourceWeb     Source = "web"
	SourceMcp     Source = "mcp"
	SourceService Source = "service"
	SourceDev     Source = "dev"
	SourceSSO     Source = "sso"
)

// Context is the resolved authentication handed to each route.
type Context struct {
	OrgID              string
	UserID             string
	Mode               Mode
	Source             Source
	ServiceTokenSuffix string
	BrowserSessionID   string
	// MembershipRole is the org_members row's role when one exists; empty
	// for the dev-headers admin auto-grant case (permissions layer decides).
	MembershipRole string
	// Email is the verified provider email (Supabase or browser session); for
	// dev-headers and service tokens it remains empty because those transports
	// do not prove ownership of an email address.
	Email string
}

// Identity is provider-verified identity before tenant membership. Only
// bootstrap/session routes may consume it; tenant routes require Context.
type Identity struct {
	UserID             string
	Email              string
	Mode               Mode
	Source             Source
	OrgHint            string
	ServiceTokenSuffix string
	BrowserSessionID   string
}

// PolicyInput is the provider-neutral shape handed to the one per-org policy
// evaluator after membership resolution proves the tenant. The auth package
// owns the invocation seam; the concrete evaluator is injected at server boot
// to avoid coupling provider extraction to policy storage/audit packages.
type PolicyInput struct {
	OrgID, UserID, Email string
	Mode                 Mode
}

// PolicyEvaluator returns false when the resolved principal must not enter the
// tenant. Implementations are fail-soft on their own storage/audit writes.
type PolicyEvaluator func(context.Context, PolicyInput) bool

// principal is the untrusted carrier of provider-supplied claims.
type principal struct {
	providerName       Mode
	providerUserID     string
	providerUserEmail  string
	providerOrgHint    string
	declaredSource     Source
	serviceTokenSuffix string
	browserSessionID   string
}

// Resolver owns the provider chain and the membership resolution.
type Resolver struct {
	pool *pgxpool.Pool
	// Seams for tests and for the Supabase HTTP verifier.
	supabaseURL      string
	supabaseKey      string
	serviceToken     string
	allowDevHeaders  bool
	verifySupabase   func(ctx context.Context, token string) (userID string, email string, ok bool)
	getActiveSession func(ctx context.Context, sessionID string) (store.AuthSession, error)
	evaluatePolicy   PolicyEvaluator
}

// Config mirrors the contract's boot-time gate inputs.
type Config struct {
	SupabaseURL     string
	SupabaseKey     string
	ServiceToken    string
	Production      bool
	AllowDevHeaders bool
}

// ConfigFromEnv reads the contract's environment contract.
func ConfigFromEnv() Config {
	return Config{
		SupabaseURL:     os.Getenv("SUPABASE_URL"),
		SupabaseKey:     os.Getenv("SUPABASE_SERVICE_ROLE_KEY"),
		ServiceToken:    os.Getenv("JANUSLY_API_SERVICE_TOKEN"),
		Production:      config.IsProduction(nil),
		AllowDevHeaders: os.Getenv("ALLOW_DEV_AUTH_HEADERS") == "true",
	}
}

// BootError is the contract's fail-fast: production without Supabase and
// without the explicit dev-headers override must refuse to start, and the
// dev-headers override must never coexist with a configured identity
// provider in production — a value carried over from staging would let
// forgeable x-user-id headers stand next to real Supabase identities.
func (c Config) BootError() error {
	if c.SupabaseURL == "" && c.Production && !c.AllowDevHeaders {
		return errProductionAuth
	}
	if c.Production && c.AllowDevHeaders && c.SupabaseURL != "" {
		return errProductionDevHeaders
	}
	return nil
}

type authBootError struct{}

func (authBootError) Error() string {
	return "Production requires Supabase auth (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) or explicit ALLOW_DEV_AUTH_HEADERS=true."
}

var errProductionAuth = authBootError{}

type devHeadersBootError struct{}

func (devHeadersBootError) Error() string {
	return "ALLOW_DEV_AUTH_HEADERS=true must not be combined with Supabase auth when JANUSLY_ENV=production."
}

var errProductionDevHeaders = devHeadersBootError{}

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
	r.getActiveSession = func(ctx context.Context, sessionID string) (store.AuthSession, error) {
		return store.New(pool).GetActiveAuthSession(ctx, sessionID)
	}
	return r
}

// SetPolicyEvaluator wires the centralized policy boundary at process boot.
// Tests that exercise extraction in isolation may leave it nil.
func (rv *Resolver) SetPolicyEvaluator(evaluate PolicyEvaluator) { rv.evaluatePolicy = evaluate }

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

// extract runs the chain in the contract's priority order.
func (rv *Resolver) extract(ctx context.Context, r *http.Request) (*principal, error) {
	// 1. Janusly browser session. Missing, invalid, revoked, or expired
	// sessions fall through; store failures remain visible to the dispatcher.
	if sessionID := browsersession.ReadSessionID(r); sessionID != "" {
		session, err := rv.getActiveSession(ctx, sessionID)
		if err == nil {
			return &principal{
				providerName: ModeJanuslySession, providerUserID: session.UserID,
				providerUserEmail: session.Email, providerOrgHint: session.OrgID,
				declaredSource: SourceSSO, browserSessionID: session.ID,
			}, nil
		}
		if !errorsIsNoRows(err) {
			return nil, err
		}
	}
	// 2. Supabase JWT.
	if rv.supabaseURL != "" {
		if header := r.Header.Get("Authorization"); strings.HasPrefix(header, "Bearer ") &&
			!constantTimeBearerMatch(header, rv.serviceToken) {
			token := strings.TrimPrefix(header, "Bearer ")
			if userID, email, ok := rv.verifySupabase(ctx, token); ok {
				return &principal{
					providerName:      ModeSupabase,
					providerUserID:    userID,
					providerUserEmail: email,
					providerOrgHint:   strings.TrimSpace(r.Header.Get("x-org-id")),
					// Hardcoded: a browser cannot self-declare MCP.
					declaredSource: SourceWeb,
				}, nil
			}
			return nil, nil // a Bearer that fails verification never falls through
		}
	}
	// 3. Service token.
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
		}, nil
	}
	// 4. Dev headers.
	if rv.allowDevHeaders {
		orgID := strings.TrimSpace(r.Header.Get("x-org-id"))
		userID := strings.TrimSpace(r.Header.Get("x-user-id"))
		if orgID != "" && userID != "" {
			return &principal{
				providerName:      ModeDevHeaders,
				providerUserID:    userID,
				providerUserEmail: "",
				providerOrgHint:   orgID,
				declaredSource:    declaredSource(r, SourceDev),
			}, nil
		}
	}
	return nil, nil
}

// ResolveIdentity returns provider-verified identity without requiring a
// membership row. It is the only valid resolver for zero-membership bootstrap.
func (rv *Resolver) ResolveIdentity(ctx context.Context, r *http.Request) (*Identity, error) {
	p, err := rv.extract(ctx, r)
	if err != nil || p == nil {
		return nil, err
	}
	return &Identity{
		UserID: p.providerUserID, Email: strings.ToLower(p.providerUserEmail),
		Mode: p.providerName, Source: p.declaredSource, OrgHint: p.providerOrgHint,
		ServiceTokenSuffix: p.serviceTokenSuffix, BrowserSessionID: p.browserSessionID,
	}, nil
}

// Resolve maps a request to a Context or nil (the dispatcher 401s).
func (rv *Resolver) Resolve(ctx context.Context, r *http.Request) (*Context, error) {
	p, err := rv.extract(ctx, r)
	if err != nil {
		return nil, err
	}
	if p == nil {
		return nil, nil
	}
	q := store.New(rv.pool)
	var resolved *Context
	switch p.providerName {
	case ModeSupabase, ModeJanuslySession:
		resolved, err = rv.resolveHumanMembership(ctx, q, p)
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
		resolved = &Context{
			OrgID: orgID, UserID: p.providerUserID, Mode: ModeServiceToken,
			Source: p.declaredSource, ServiceTokenSuffix: p.serviceTokenSuffix,
			MembershipRole: role,
		}
	default: // dev-headers
		role := ""
		if membership, err := q.GetOrgMembership(ctx, store.GetOrgMembershipParams{
			OrgID: p.providerOrgHint, UserID: p.providerUserID,
		}); err == nil {
			role = membership.Role
		} else if !errorsIsNoRows(err) {
			return nil, err
		}
		resolved = &Context{
			OrgID: p.providerOrgHint, UserID: p.providerUserID,
			Mode: ModeDevHeaders, Source: p.declaredSource,
			MembershipRole: role, Email: p.providerUserEmail,
		}
	}
	if err != nil || resolved == nil {
		return resolved, err
	}
	if rv.evaluatePolicy != nil && !rv.evaluatePolicy(ctx, PolicyInput{
		OrgID: resolved.OrgID, UserID: resolved.UserID, Email: resolved.Email, Mode: resolved.Mode,
	}) {
		return nil, nil
	}
	return resolved, nil
}

// resolveHumanMembership: the security-relevant branch — the hint is a
// SCOPE selector; the grant is the org_members row. The runtime ports steps
// 1 (direct match), 3 (hint-less single membership) and 4 (hint-less
// multiple → nil); the provisioning paths (legacy backfill, invitations,
// verified domains, SSO JIT) stay with the contract for now.
func (rv *Resolver) resolveHumanMembership(ctx context.Context, q *store.Queries, p *principal) (*Context, error) {
	if p.providerOrgHint != "" {
		membership, err := q.GetOrgMembership(ctx, store.GetOrgMembershipParams{
			OrgID: p.providerOrgHint, UserID: p.providerUserID,
		})
		if err == nil {
			return &Context{
				OrgID: p.providerOrgHint, UserID: p.providerUserID,
				Mode: p.providerName, Source: p.declaredSource, MembershipRole: membership.Role,
				Email:            strings.ToLower(p.providerUserEmail),
				BrowserSessionID: p.browserSessionID,
			}, nil
		}
		if !errorsIsNoRows(err) {
			return nil, err
		}
		// Step 2 — legacy-orphan lazy backfill: a pre-invite-acceptance row
		// seeded userId with the EMAIL as placeholder; on first real
		// sign-in, rewrite it to the provider UUID and accept the grant.
		// (The member.userid.migrated audit row lands with the audit
		// retrofit ticket.)
		if p.providerUserEmail != "" {
			byEmail, err := q.FindOrgMemberByEmail(ctx, store.FindOrgMemberByEmailParams{
				OrgID: p.providerOrgHint, Lower: p.providerUserEmail,
			})
			if err == nil && byEmail.UserID != p.providerUserID && strings.Contains(byEmail.UserID, "@") {
				if _, err := q.MigrateOrgMemberUserID(ctx, store.MigrateOrgMemberUserIDParams{
					ID: byEmail.ID, OrgID: p.providerOrgHint, UserID: p.providerUserID,
				}); err != nil {
					return nil, err
				}
				return &Context{
					OrgID: p.providerOrgHint, UserID: p.providerUserID,
					Mode: p.providerName, Source: p.declaredSource, MembershipRole: byEmail.Role,
					Email:            strings.ToLower(p.providerUserEmail),
					BrowserSessionID: p.browserSessionID,
				}, nil
			}
			if err != nil && !errorsIsNoRows(err) {
				return nil, err
			}
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
			Mode: p.providerName, Source: p.declaredSource, MembershipRole: memberships[0].Role,
			Email:            strings.ToLower(p.providerUserEmail),
			BrowserSessionID: p.browserSessionID,
		}, nil
	}
	return nil, nil // zero or ambiguous — force x-org-id
}

func errorsIsNoRows(err error) bool {
	// errors.Is, not == plus a message comparison: a wrapped ErrNoRows
	// ("read membership: no rows in result set") defeated BOTH of the old
	// clauses, turning "this principal has no grant" into a hard failure
	// on the authentication hot path. The store is sqlc-generated and
	// returns the raw pgx error today, so this is a landmine, not a live
	// bug — but the rest of the repo already uses errors.Is here.
	return errors.Is(err, pgx.ErrNoRows)
}

// verifySupabaseHTTP validates the access token against the Supabase Auth
// API — the same network validation the contract performs through its
// SDK (supabase.auth.getUser). Full implementation lands with the
// supabase-mode ticket; the seam exists so tests can inject verifiers.
func (rv *Resolver) verifySupabaseHTTP(ctx context.Context, token string) (string, string, bool) {
	return verifySupabaseUser(ctx, rv.supabaseURL, rv.supabaseKey, token)
}
