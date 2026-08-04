// Per-tenant HTTP bound resolution over the shared org_configs table —
// the runtime's subset of the contract's org-config catalog. Precedence per
// key, matching the catalog contract: valid tenant row → env override →
// catalog default. Values below the catalog minimum (timeoutMs ≥ 1,
// maxResponseBytes ≥ 1, maxRedirects ≥ 0) fall through to the next layer
// instead of half-applying.
package engine

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/store"
)

type httpBoundSpec struct {
	key    string
	envKey string
	min    float64
	def    float64
}

var httpBoundSpecs = []httpBoundSpec{
	{key: "http.timeoutMs", envKey: "JANUSLY_HTTP_TIMEOUT_MS", min: 1, def: 30_000},
	{key: "http.maxResponseBytes", envKey: "JANUSLY_HTTP_MAX_RESPONSE_BYTES", min: 1, def: 1_000_000},
	{key: "http.maxRedirects", envKey: "JANUSLY_HTTP_MAX_REDIRECTS", min: 0, def: 5},
	{key: "http.streamPreviewBytes", envKey: "JANUSLY_HTTP_STREAM_PREVIEW_BYTES", min: 1_024, def: 65_536},
}

// resolveHTTPBounds applies the precedence chain over already-loaded tenant
// values. Pure — the DB read lives in LoadOrgHTTPBounds.
func resolveHTTPBounds(tenant map[string]float64, lookupEnv func(string) (string, bool)) executors.HTTPBounds {
	resolved := make([]float64, len(httpBoundSpecs))
	for i, spec := range httpBoundSpecs {
		value := spec.def
		if env, ok := lookupEnv(spec.envKey); ok {
			if parsed, err := strconv.ParseFloat(env, 64); err == nil && parsed >= spec.min {
				value = parsed
			}
		}
		if row, ok := tenant[spec.key]; ok && row >= spec.min {
			value = row
		}
		resolved[i] = value
	}
	preview := resolved[3]
	if preview > 1_048_576 {
		preview = 1_048_576 // catalog max — above it falls to the cap, not the default
	}
	return executors.HTTPBounds{
		TimeoutMs:          resolved[0],
		MaxResponseBytes:   int(resolved[1]),
		MaxRedirects:       int(resolved[2]),
		StreamPreviewBytes: int(preview),
	}
}

// LoadOrgHTTPBounds reads the tenant's http-category rows and resolves the
// effective bounds. A failed read degrades to env/defaults — an unreadable
// config row must never fail a node that would otherwise run.
func LoadOrgHTTPBounds(ctx context.Context, q *store.Queries, orgID string, lookupEnv func(string) (string, bool)) executors.HTTPBounds {
	tenant := map[string]float64{}
	rows, err := q.ListOrgHTTPConfig(ctx, orgID)
	if err == nil {
		for _, row := range rows {
			var value float64
			if json.Unmarshal(row.ValueJson, &value) == nil {
				tenant[row.Key] = value
			}
		}
	}
	return resolveHTTPBounds(tenant, lookupEnv)
}
