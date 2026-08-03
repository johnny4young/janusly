// Package authpolicy is the single per-organization human-login policy
// boundary. The request resolver and WorkOS callback both call this evaluator;
// individual routes do not reinterpret SSO, domain, MFA, or session-TTL rules.
package authpolicy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/store"
)

const (
	PolicyEnforcedSSO   = "sso_connections.enforced_sso"
	PolicyAllowedDomain = "auth.allowedEmailDomains"
	PolicyMFARequired   = "auth.mfaRequired"
	// PolicyUnavailable marks a denial caused by an unreadable policy
	// store rather than by a configured rule — distinguishable in the
	// audit trail so an outage is never mistaken for a real rejection.
	PolicyUnavailable = "auth.policyUnavailable"

	defaultSessionTTLSeconds = 28_800
)

// Config is the bounded three-key policy snapshot read on the auth hot path.
type Config struct {
	AllowedEmailDomains []string
	MFARequired         bool
	SessionTTLSeconds   int
}

// Input describes a provider-verified principal at a proved organization.
// ProvidedConnection distinguishes an intentional nil from "read it here".
type Input struct {
	OrgID, UserID, Email string
	Mode                 auth.Mode
	Connection           *store.SsoConnection
	ProvidedConnection   bool
}

// Decision always carries the issuance TTL; rejected requests additionally
// identify the deterministic policy key and stable reason.
type Decision struct {
	Allowed           bool
	Reason            string
	PolicyKey         string
	SessionTTLSeconds int
}

// Evaluator owns the fail-soft policy reads and rejection audit chokepoint.
type Evaluator struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Evaluator { return &Evaluator{pool: pool} }

func defaultConfig() Config { return Config{SessionTTLSeconds: defaultSessionTTLSeconds} }

// LoadConfig reads only the three auth keys. A storage fault is REPORTED,
// not absorbed: an org with no policy rows is "no policy configured"
// (allow), while a failed read is "policy unknown" — and those two must
// never collapse into the same answer on an authorization path.
func LoadConfig(ctx context.Context, db store.DBTX, orgID string) (Config, error) {
	config := defaultConfig()
	rows, err := store.New(db).ListAuthPolicyConfigRows(ctx, orgID)
	if err != nil {
		return config, fmt.Errorf("read auth policy config: %w", err)
	}
	for _, row := range rows {
		switch row.Key {
		case PolicyAllowedDomain:
			var raw string
			if json.Unmarshal(row.ValueJson, &raw) == nil {
				config.AllowedEmailDomains = parseDomains(raw)
			}
		case PolicyMFARequired:
			var value bool
			if json.Unmarshal(row.ValueJson, &value) == nil {
				config.MFARequired = value
			}
		case "auth.sessionTtlSeconds":
			var value float64
			if json.Unmarshal(row.ValueJson, &value) == nil && value >= 300 && value <= 86_400 {
				config.SessionTTLSeconds = int(value)
			}
		}
	}
	return config, nil
}

func parseDomains(raw string) []string {
	domains := make([]string, 0, strings.Count(raw, ",")+1)
	for entry := range strings.SplitSeq(raw, ",") {
		if domain := strings.ToLower(strings.TrimSpace(entry)); domain != "" {
			domains = append(domains, domain)
		}
	}
	return domains
}

func domainAllowed(email string, domains []string) bool {
	_, domain, found := strings.Cut(strings.ToLower(email), "@")
	if !found || domain == "" {
		return false
	}
	return slices.Contains(domains, domain)
}

// devSSOBypassEnabled reads the development escape hatch. It is refused
// outright in production: unlike ALLOW_DEV_AUTH_HEADERS, this flag also
// disables enforced SSO for REAL provider identities (Supabase), so a
// stray value copied into a production environment would silently and
// permanently switch off an organization's SSO requirement. cmd/api also
// refuses to boot with it set, making this defense in depth for any other
// binary or test harness that constructs an Evaluator directly.
func devSSOBypassEnabled() bool {
	if os.Getenv("ALLOW_DEV_SSO_BYPASS") != "true" {
		return false
	}
	if strings.TrimSpace(os.Getenv("JANUSLY_ENV")) == "production" ||
		os.Getenv("JANUSLY_PRODUCTION_MODE") == "true" {
		slog.Error("[auth-policy] ALLOW_DEV_SSO_BYPASS is set in production and is being IGNORED")
		return false
	}
	return true
}

// Decide is the pure policy matrix. Ordering is security-significant:
// enforced SSO wins before domain policy; MFA remains visibility-only.
func Decide(input Input, config Config, connection *store.SsoConnection, allowDevSSOBypass bool) Decision {
	allowed := Decision{Allowed: true, SessionTTLSeconds: config.SessionTTLSeconds}
	if input.Mode == auth.ModeServiceToken {
		return allowed
	}
	if input.Mode == auth.ModeSupabase || input.Mode == auth.ModeDevHeaders {
		if connection != nil && connection.Status == "active" && connection.EnforcedSso && !allowDevSSOBypass {
			return Decision{
				Reason: "org requires SSO login", PolicyKey: PolicyEnforcedSSO,
				SessionTTLSeconds: config.SessionTTLSeconds,
			}
		}
	}
	if len(config.AllowedEmailDomains) > 0 &&
		(input.Mode == auth.ModeSupabase || input.Mode == auth.ModeJanuslySession) &&
		!domainAllowed(input.Email, config.AllowedEmailDomains) {
		return Decision{
			Reason: "email domain not in allowed list", PolicyKey: PolicyAllowedDomain,
			SessionTTLSeconds: config.SessionTTLSeconds,
		}
	}
	return allowed
}

// readConnection separates "this org has no SSO connection" (nil, nil —
// a legitimate answer) from "the connection could not be read" (error).
// Collapsing the second into the first is what silently disabled
// enforced SSO during a storage blip.
func (e *Evaluator) readConnection(ctx context.Context, input Input) (*store.SsoConnection, error) {
	if input.ProvidedConnection {
		return input.Connection, nil
	}
	connection, err := store.New(e.pool).FindSsoConnectionForOrg(ctx, input.OrgID)
	if errorsIsNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read sso connection: %w", err)
	}
	return &connection, nil
}

// Evaluate loads the narrow policy, makes one deterministic decision, and
// writes a best-effort rejection receipt. It never returns a storage error.
func (e *Evaluator) Evaluate(ctx context.Context, input Input) Decision {
	config, configErr := LoadConfig(ctx, e.pool, input.OrgID)
	var connection *store.SsoConnection
	var connectionErr error
	if input.Mode == auth.ModeSupabase || input.Mode == auth.ModeDevHeaders {
		connection, connectionErr = e.readConnection(ctx, input)
	}
	var decision Decision
	switch {
	// Service tokens carry no user-facing policy (Decide returns early for
	// them), so a policy-store fault must not take machine callers down.
	case input.Mode == auth.ModeServiceToken:
		decision = Decide(input, config, connection, devSSOBypassEnabled())
	// Fail CLOSED: enforced SSO and the allowed-domain list are exactly the
	// controls a transient storage error used to switch off, and a partial
	// outage (membership read succeeds, policy read times out) is precisely
	// when that window opens. An unreadable policy is not an absent policy.
	case configErr != nil || connectionErr != nil:
		slog.Error("[auth-policy] policy store unavailable; denying",
			"orgId", input.OrgID, "mode", input.Mode,
			"configError", configErr, "connectionError", connectionErr)
		decision = Decision{
			Reason: "auth policy store unavailable", PolicyKey: PolicyUnavailable,
			SessionTTLSeconds: config.SessionTTLSeconds,
		}
	default:
		decision = Decide(input, config, connection, devSSOBypassEnabled())
	}
	if !decision.Allowed {
		var email any
		if input.Email != "" {
			email = input.Email
		}
		audit.WriteAs(ctx, e.pool, input.OrgID, input.UserID, "auth.policy.rejected", audit.Options{
			TargetType: "user", TargetID: input.UserID,
			Metadata: map[string]any{
				"policyKey": decision.PolicyKey, "reason": decision.Reason,
				"mode": string(input.Mode), "email": email,
			},
		})
		return decision
	}
	if config.MFARequired && (input.Mode == auth.ModeSupabase || input.Mode == auth.ModeJanuslySession) {
		slog.Warn("[auth-policy] MFA is required but the principal has no verifiable MFA claim; allowing marker-only policy",
			"orgId", input.OrgID, "mode", input.Mode)
	}
	return decision
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
