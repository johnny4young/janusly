package agentclient

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/store"
)

// ErrInvalidToken is the single answer for a malformed, unknown, expired or
// revoked token, or one whose creator left the organization.
var ErrInvalidToken = errors.New("agent token is invalid, expired or revoked")

// Principal is one agent client's authority for one call.
type Principal struct {
	ClientID           string
	OrgID              string
	Name               string
	CreatedBy          string
	Capabilities       []Capability
	ScopeWorkflowIDs   []string
	ScopeTags          []string
	RateLimitPerMinute int
	ExpiresAt          time.Time
	// Permissions is the ceiling intersected with the creator's live grant.
	Permissions map[string]bool
	// Tools is the set of MCP tools the ceiling reaches.
	Tools map[string]bool
}

// ActorID is the identity recorded in audit rows, runs and versions.
func (p *Principal) ActorID() string { return "agent:" + p.ClientID }

// Scoped reports whether the client is limited to some workflows.
func (p *Principal) Scoped() bool {
	return len(p.ScopeWorkflowIDs) > 0 || len(p.ScopeTags) > 0
}

// Resolver turns a bearer token into a Principal on every call, so
// revocation, expiry and creator demotion apply to the next request.
type Resolver struct {
	Pool *pgxpool.Pool
	Now  func() time.Time
}

func (r Resolver) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// Resolve returns ErrInvalidToken for every credential failure and wraps
// only store errors.
func (r Resolver) Resolve(ctx context.Context, token string) (*Principal, error) {
	if !wellFormed(token) {
		return nil, ErrInvalidToken
	}
	q := store.New(r.Pool)
	row, err := q.GetAgentClientByTokenDigest(ctx, Digest(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrInvalidToken
	}
	if err != nil {
		return nil, err
	}
	if row.RevokedAt != nil || !r.now().Before(row.ExpiresAt) {
		return nil, ErrInvalidToken
	}
	capabilities, err := ParseCapabilities(row.Capabilities)
	if err != nil {
		return nil, ErrInvalidToken
	}
	held, err := CreatorPermissions(ctx, q, row.OrgID, row.CreatedBy)
	if err != nil {
		return nil, err
	}
	if held == nil {
		return nil, ErrInvalidToken
	}
	permissions := map[string]bool{}
	for permission := range CeilingPermissions(capabilities) {
		if held[permission] {
			permissions[permission] = true
		}
	}
	// Telemetry only; a failed touch must not fail the call.
	_ = q.TouchAgentClientLastUsed(ctx, row.ID)
	return &Principal{
		ClientID: row.ID, OrgID: row.OrgID, Name: row.Name, CreatedBy: row.CreatedBy,
		Capabilities:     capabilities,
		ScopeWorkflowIDs: row.ScopeWorkflowIds, ScopeTags: row.ScopeTags,
		RateLimitPerMinute: int(row.RateLimitPerMinute), ExpiresAt: row.ExpiresAt,
		Permissions: permissions, Tools: CeilingTools(capabilities),
	}, nil
}

// CreatorPermissions is a person's effective grant in the organization, or
// nil when they are no longer a member. Development-header admin defaults
// never apply: an agent acts for a real membership.
func CreatorPermissions(ctx context.Context, q *store.Queries, orgID, userID string) (map[string]bool, error) {
	role, err := auth.ResolveMemberRole(ctx, q, orgID, userID, auth.ModeSupabase)
	if err != nil || role == nil {
		return nil, err
	}
	return auth.EffectivePermissions(ctx, q, orgID, role)
}
