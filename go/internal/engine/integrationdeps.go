// Engine-built runtime seams for the integration-tool chokepoint: the
// credential gate (org-scoped lookup + SecretStore resolution + the
// org+credential rate limit), the usage recorder (one usage_events row
// per call, dropped silently on failure), and the guarded egress
// (executors.FetchHTTPTarget — the only door out). Built per node by the
// dispatcher, mirroring the memory-deps pattern.
package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/executors"
	"github.com/johnny4young/janusly/go/internal/orgconfig"
	"github.com/johnny4young/janusly/go/internal/ratelimit"
	"github.com/johnny4young/janusly/go/internal/secretstore"
	"github.com/johnny4young/janusly/go/internal/store"
	"github.com/johnny4young/janusly/go/internal/tools"
)

// integrationEnvBound reads JANUSLY_<FAMILY>_RATE_LIMIT_PER_MIN.
func integrationEnvBound(family string, fallback int) int {
	raw := os.Getenv("JANUSLY_" + toUpperSnake(family) + "_RATE_LIMIT_PER_MIN")
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		return fallback
	}
	return value
}

func toUpperSnake(family string) string {
	out := make([]rune, 0, len(family))
	for _, r := range family {
		if r >= 'a' && r <= 'z' {
			out = append(out, r-32)
		} else {
			out = append(out, r)
		}
	}
	return string(out)
}

// buildIntegrationDeps wires the chokepoint for one node execution.
func (e *Engine) buildIntegrationDeps(orgID, runID, nodeID string) *tools.IntegrationDeps {
	limiter := ratelimit.New(e.pool, ratelimit.Hooks{})
	return &tools.IntegrationDeps{
		Gate: func(ctx context.Context, tool, credentialKind, credentialName string, rateLimitPerMin int) (string, string) {
			q := store.New(e.pool)
			credential, err := q.GetCredentialByName(ctx, store.GetCredentialByNameParams{
				OrgID: orgID, Kind: credentialKind, Name: credentialName,
			})
			if err != nil {
				return "", "credential not found: " + credentialName
			}
			secret := secretstore.ResolveCredentialSecretRef(ctx, q, orgID, credential.SecretRef)
			if secret == "" {
				// Deliberately generic — never echo the managed/legacy ref.
				return "", "credential secret missing for " + credentialName
			}
			// The bucket is org+credential-scoped: one noisy credential
			// cannot starve the tenant's other integrations.
			if err := limiter.Enforce(ctx, orgID, ratelimit.Options{
				Name: "tool." + tool + "." + credentialName, Max: rateLimitPerMin, Window: time.Minute,
			}); err != nil {
				return "", err.Error()
			}
			return secret, ""
		},
		Record: func(tool, credentialName string, ok bool, statusCode int, errMessage string, latencyMs int) {
			metadata := map[string]any{
				"credentialName": credentialName, "ok": ok, "latencyMs": latencyMs, "nodeId": nodeID,
			}
			if statusCode > 0 {
				metadata["statusCode"] = statusCode
			}
			if errMessage != "" {
				metadata["error"] = errMessage
			}
			metadataJSON, err := json.Marshal(metadata)
			if err != nil {
				return
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			// Telemetry never breaks the tool: errors drop silently.
			_ = store.New(e.pool).InsertUsageEvent(ctx, store.InsertUsageEventParams{
				ID: e.newID(), OrgID: orgID,
				RunID:    pgtype.Text{String: runID, Valid: runID != ""},
				Metric:   "tool." + tool,
				Quantity: 1, Metadata: metadataJSON,
			})
		},
		Post: func(ctx context.Context, url string, headers map[string]string, body []byte) (int, string, string) {
			result, err := executors.FetchHTTPTarget(ctx, url, executors.FetchOptions{
				Method: "POST", Headers: headers, Body: body,
			})
			if err != nil {
				return 0, "", err.Error()
			}
			return result.StatusCode, result.Body, ""
		},
		RateLimit: func(ctx context.Context, bucket string, perMin int) string {
			if err := limiter.Enforce(ctx, orgID, ratelimit.Options{
				Name: bucket, Max: perMin, Window: time.Minute,
			}); err != nil {
				return err.Error()
			}
			return ""
		},
		Email: func() tools.EmailSettings {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			provider, _ := orgconfig.LoadValue(ctx, e.pool, orgID, "email.provider").(string)
			from, _ := orgconfig.LoadValue(ctx, e.pool, orgID, "email.from").(string)
			return tools.EmailSettings{Provider: provider, From: from}
		},
		RateLimitPerMin: func(family string, fallback int) int {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if configured := orgconfig.LoadNumber(ctx, e.pool, orgID,
				fmt.Sprintf("integrations.%s.rateLimitPerMin", family)); configured > 0 {
				return int(configured)
			}
			return integrationEnvBound(family, fallback)
		},
	}
}
