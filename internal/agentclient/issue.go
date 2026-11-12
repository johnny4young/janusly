package agentclient

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/johnny4young/janusly/internal/store"
)

const (
	DefaultExpiryDays    = 30
	MaxExpiryDays        = 90
	DefaultRatePerMinute = 120
	MaxRatePerMinute     = 600
	maxScopeWorkflowIDs  = 100
	maxScopeTags         = 20
)

// InputError names the field a person must change.
type InputError struct {
	Code    string
	Field   string
	Message string
	Params  map[string]any
}

func (e *InputError) Error() string { return e.Message }

// IssueInput is what a person asks for; CreatedBy is the authenticated
// person, never a body field.
type IssueInput struct {
	OrgID              string
	CreatedBy          string
	Name               string
	Capabilities       []string
	ScopeWorkflowIDs   []string
	ScopeTags          []string
	ExpiresInDays      int
	RateLimitPerMinute int
}

// Issued carries the only copy of the plaintext token.
type Issued struct {
	Client store.AgentClient
	Token  string
}

// Issue validates the request against the creator's grant and stores the
// client with a fresh token digest.
func Issue(ctx context.Context, q *store.Queries, id string, now time.Time, in IssueInput, held map[string]bool) (Issued, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" || utf8.RuneCountInString(name) > 120 {
		return Issued{}, &InputError{Code: "invalid_name", Field: "name", Message: "name is required and must be at most 120 characters"}
	}
	capabilities, err := ParseCapabilities(in.Capabilities)
	if err != nil {
		return Issued{}, &InputError{Code: "invalid_capabilities", Field: "capabilities",
			Message: "capabilities may contain only read, propose, test, publish, operate and report"}
	}
	if missing := MissingPermissions(capabilities, held); len(missing) > 0 {
		return Issued{}, &InputError{Code: "capability_exceeds_grant", Field: "capabilities",
			Message: "you cannot grant an agent permissions you do not hold",
			Params:  map[string]any{"missingPermissions": missing}}
	}
	workflowIDs, err := scopeValues(in.ScopeWorkflowIDs, maxScopeWorkflowIDs, 256, "scope.workflowIds")
	if err != nil {
		return Issued{}, err
	}
	tags, err := scopeValues(in.ScopeTags, maxScopeTags, 60, "scope.tags")
	if err != nil {
		return Issued{}, err
	}
	expiresAt, err := expiry(now, in.ExpiresInDays)
	if err != nil {
		return Issued{}, err
	}
	rate := in.RateLimitPerMinute
	if rate == 0 {
		rate = DefaultRatePerMinute
	}
	if rate < 1 || rate > MaxRatePerMinute {
		return Issued{}, &InputError{Code: "invalid_rate_limit", Field: "rateLimitPerMinute",
			Message: "rateLimitPerMinute must be between 1 and 600"}
	}
	token, digest, last4, err := NewToken()
	if err != nil {
		return Issued{}, err
	}
	row, err := q.CreateAgentClient(ctx, store.CreateAgentClientParams{
		ID: id, OrgID: in.OrgID, Name: name, Capabilities: Strings(capabilities),
		ScopeWorkflowIds: workflowIDs, ScopeTags: tags,
		TokenDigest: digest, TokenLast4: last4, RateLimitPerMinute: int32(rate),
		CreatedBy: in.CreatedBy, TokenIssuedAt: now, ExpiresAt: expiresAt,
	})
	if err != nil {
		return Issued{}, err
	}
	return Issued{Client: row, Token: token}, nil
}

// Rotate replaces the token at once and restarts its lifetime. A revoked or
// expired client is not rotated: the store answers no row.
func Rotate(ctx context.Context, q *store.Queries, orgID, id string, now time.Time, expiresInDays int) (Issued, error) {
	expiresAt, err := expiry(now, expiresInDays)
	if err != nil {
		return Issued{}, err
	}
	token, digest, last4, err := NewToken()
	if err != nil {
		return Issued{}, err
	}
	row, err := q.RotateAgentClientToken(ctx, store.RotateAgentClientTokenParams{
		OrgID: orgID, ID: id, TokenDigest: digest, TokenLast4: last4,
		TokenIssuedAt: now, ExpiresAt: expiresAt,
	})
	if err != nil {
		return Issued{}, err
	}
	return Issued{Client: row, Token: token}, nil
}

func expiry(now time.Time, days int) (time.Time, error) {
	if days == 0 {
		days = DefaultExpiryDays
	}
	if days < 1 || days > MaxExpiryDays {
		return time.Time{}, &InputError{Code: "invalid_expiry", Field: "expiresInDays",
			Message: "expiresInDays must be between 1 and 90"}
	}
	return now.Add(time.Duration(days) * 24 * time.Hour), nil
}

// scopeValues matches the workflow id and tag rules: non-blank, bounded, no
// control characters.
func scopeValues(values []string, limit, maxLen int, field string) ([]string, error) {
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || len(value) > maxLen || strings.ContainsFunc(value, unicode.IsControl) {
			return nil, &InputError{Code: "invalid_scope", Field: field,
				Message: fmt.Sprintf("%s entries must be 1-%d characters without control characters", field, maxLen)}
		}
		if !slices.Contains(out, value) {
			out = append(out, value)
		}
	}
	if len(out) > limit {
		return nil, &InputError{Code: "invalid_scope", Field: field, Message: field + " has too many entries"}
	}
	slices.Sort(out)
	return out, nil
}
