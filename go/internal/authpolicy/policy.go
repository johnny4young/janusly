// Package authpolicy is the single per-organization human-login policy
// boundary. The request resolver and WorkOS callback both call this evaluator;
// individual routes do not reinterpret SSO, domain, MFA, or session-TTL rules.
package authpolicy

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/auth"
	"github.com/johnny4young/janusly/go/internal/store"
)

const (
	PolicyEnforcedSSO   = "sso_connections.enforced_sso"
	PolicyAllowedDomain = "auth.allowedEmailDomains"
	PolicyMFARequired   = "auth.mfaRequired"

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

// LoadConfig reads only the three auth keys. A storage fault returns catalog
// defaults, matching the compatibility runtime's availability posture.
func LoadConfig(ctx context.Context, db store.DBTX, orgID string) Config {
	config := defaultConfig()
	rows, err := store.New(db).ListAuthPolicyConfigRows(ctx, orgID)
	if err != nil {
		slog.Warn("[auth-policy] failed to read org config; using defaults", "orgId", orgID, "error", err)
		return config
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
	return config
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

func (e *Evaluator) readConnection(ctx context.Context, input Input) *store.SsoConnection {
	if input.ProvidedConnection {
		return input.Connection
	}
	connection, err := store.New(e.pool).FindSsoConnectionForOrg(ctx, input.OrgID)
	if errorsIsNoRows(err) {
		return nil
	}
	if err != nil {
		slog.Warn("[auth-policy] failed to read SSO connection; treating as absent", "orgId", input.OrgID, "error", err)
		return nil
	}
	return &connection
}

// Evaluate loads the narrow policy, makes one deterministic decision, and
// writes a best-effort rejection receipt. It never returns a storage error.
func (e *Evaluator) Evaluate(ctx context.Context, input Input) Decision {
	config := LoadConfig(ctx, e.pool, input.OrgID)
	var connection *store.SsoConnection
	if input.Mode == auth.ModeSupabase || input.Mode == auth.ModeDevHeaders {
		connection = e.readConnection(ctx, input)
	}
	decision := Decide(input, config, connection, os.Getenv("ALLOW_DEV_SSO_BYPASS") == "true")
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
