package agentclient

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/hookwire"
	"github.com/johnny4young/janusly/internal/store"
)

// ErrInvalidToken is the single answer for a malformed, unknown, expired or
// revoked token, or one whose creator left the organization.
var ErrInvalidToken = errors.New("agent token is invalid, expired or revoked")

// Rejection reasons for audit; the caller always sees ErrInvalidToken.
const (
	RejectMalformed      = "malformed"
	RejectUnknown        = "unknown"
	RejectRevoked        = "revoked"
	RejectExpired        = "expired"
	RejectCapabilities   = "invalid_capabilities"
	RejectCreatorRemoved = "creator_removed"
)

// RejectedError is ErrInvalidToken plus why, and the client and organization
// when the digest matched one.
type RejectedError struct {
	Reason   string
	ClientID string
	OrgID    string
}

func (e *RejectedError) Error() string        { return ErrInvalidToken.Error() }
func (e *RejectedError) Is(target error) bool { return target == ErrInvalidToken }

func rejected(reason string, row *store.AgentClient) error {
	err := &RejectedError{Reason: reason}
	if row != nil {
		err.ClientID, err.OrgID = row.ID, row.OrgID
	}
	return err
}

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

	digest []byte
}

// HookSigningKey is the hooks bridge HMAC key, derived from the stored token
// digest. It is never logged or returned.
func (p *Principal) HookSigningKey() string { return hookwire.SigningKeyFromDigest(p.digest) }

// ActorID is the identity recorded in audit rows, runs and versions.
func (p *Principal) ActorID() string { return "agent:" + p.ClientID }

// Has reports whether the ceiling includes capability.
func (p *Principal) Has(capability Capability) bool {
	return slices.Contains(p.Capabilities, capability)
}

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

// Resolve returns a *RejectedError, which matches ErrInvalidToken, for every
// credential failure, and wraps only store errors.
func (r Resolver) Resolve(ctx context.Context, token string) (*Principal, error) {
	if !wellFormed(token) {
		return nil, rejected(RejectMalformed, nil)
	}
	q := store.New(r.Pool)
	row, err := q.GetAgentClientByTokenDigest(ctx, Digest(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, rejected(RejectUnknown, nil)
	}
	if err != nil {
		return nil, err
	}
	if row.RevokedAt != nil {
		return nil, rejected(RejectRevoked, &row)
	}
	if !r.now().Before(row.ExpiresAt) {
		return nil, rejected(RejectExpired, &row)
	}
	capabilities, err := ParseCapabilities(row.Capabilities)
	if err != nil {
		return nil, rejected(RejectCapabilities, &row)
	}
	held, err := CreatorPermissions(ctx, q, row.OrgID, row.CreatedBy)
	if err != nil {
		return nil, err
	}
	if held == nil {
		return nil, rejected(RejectCreatorRemoved, &row)
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
		digest: row.TokenDigest,
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
