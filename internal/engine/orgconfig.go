// Per-tenant HTTP bound resolution over the shared org_configs table —
// the runtime's subset of the contract's org-config catalog. Precedence per
// key, matching the catalog contract: valid tenant row → env override →
// catalog default. Values below the catalog minimum (timeoutMs ≥ 1,
// maxResponseBytes ≥ 1, maxRedirects ≥ 0) fall through to the next layer
// instead of half-applying.
package engine

import (
	"encoding/json"
	"math"
	"strconv"

	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/httpcontract"
)

type httpBoundSpec struct {
	key    string
	envKey string
	min    float64
	max    float64
	def    float64
}

var httpBoundSpecs = []httpBoundSpec{
	{key: "http.timeoutMs", envKey: "JANUSLY_HTTP_TIMEOUT_MS", min: 1, max: httpcontract.MaxTimeoutMS, def: httpcontract.DefaultTimeoutMS},
	{key: "http.maxResponseBytes", envKey: "JANUSLY_HTTP_MAX_RESPONSE_BYTES", min: 1, max: httpcontract.MaxResponseBytes, def: httpcontract.DefaultMaxResponseBytes},
	{key: "http.maxRedirects", envKey: "JANUSLY_HTTP_MAX_REDIRECTS", min: 0, max: httpcontract.MaxRedirects, def: httpcontract.DefaultMaxRedirects},
	{key: "http.streamPreviewBytes", envKey: "JANUSLY_HTTP_STREAM_PREVIEW_BYTES", min: httpcontract.MinStreamPreview, max: httpcontract.MaxStreamPreview, def: httpcontract.DefaultStreamPreview},
}

// resolveHTTPBounds applies the precedence chain over already-loaded tenant
// values. Pure — the rows come from the claim snapshot.
func resolveHTTPBounds(tenant map[string]float64, lookupEnv func(string) (string, bool)) executors.HTTPBounds {
	resolved := make([]float64, len(httpBoundSpecs))
	for i, spec := range httpBoundSpecs {
		value := spec.def
		if env, ok := lookupEnv(spec.envKey); ok {
			if parsed, err := strconv.ParseFloat(env, 64); err == nil && validHTTPBound(parsed, spec) {
				value = parsed
			}
		}
		if row, ok := tenant[spec.key]; ok && validHTTPBound(row, spec) {
			value = row
		}
		resolved[i] = value
	}
	return executors.HTTPBounds{
		TimeoutMs:          resolved[0],
		MaxResponseBytes:   int(resolved[1]),
		MaxRedirects:       int(resolved[2]),
		StreamPreviewBytes: int(resolved[3]),
	}
}

func validHTTPBound(value float64, spec httpBoundSpec) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && math.Trunc(value) == value &&
		value >= spec.min && value <= spec.max
}

// httpBoundsFromTenantRows resolves the tenant's http bounds from rows the
// claim already holds; only the catalog's http keys are consulted.
func httpBoundsFromTenantRows(rows map[string]json.RawMessage, lookupEnv func(string) (string, bool)) executors.HTTPBounds {
	tenant := map[string]float64{}
	for _, spec := range httpBoundSpecs {
		raw, ok := rows[spec.key]
		if !ok {
			continue
		}
		var value float64
		if json.Unmarshal(raw, &value) == nil {
			tenant[spec.key] = value
		}
	}
	return resolveHTTPBounds(tenant, lookupEnv)
}
