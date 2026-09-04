// DB-backed snapshot loaders over the pure resolver — the one place
// consumers (start gate, MCP consent, retention windows) read effective
// org settings from, so every surface shares the identical layer chain.
package orgconfig

import (
	"context"
	"encoding/json"
	"os"

	"github.com/johnny4young/janusly/internal/store"
)

// Querier is the subset of the store the loaders need — *pgxpool.Pool and
// pgx.Tx both satisfy store.DBTX.
type Querier = store.DBTX

// ValueWithSource is one effective value plus its resolution provenance.
// Consumers that make a security decision from provenance (for example,
// tenant-authored URLs versus operator environment URLs) must use this form.
type ValueWithSource struct {
	Value  any
	Source string
}

// LoadResolved reads the org's tenant rows once and resolves the whole
// catalog against the process environment.
func LoadResolved(ctx context.Context, db Querier, orgID string) ([]Resolved, error) {
	rows, err := store.New(db).ListOrgConfigRows(ctx, orgID)
	if err != nil {
		return nil, err
	}
	tenantRows := make(map[string]json.RawMessage, len(rows))
	for _, row := range rows {
		tenantRows[row.Key] = row.ValueJson
	}
	return ResolveAll(tenantRows, os.LookupEnv), nil
}

// LoadValue resolves one key's effective value through the same chain.
// Failures degrade to the catalog default — config reads must never take
// the governed operation down.
func LoadValue(ctx context.Context, db Querier, orgID, key string) any {
	value, _ := LoadValueWithSource(ctx, db, orgID, key)
	return value
}

// LoadValueWithSource is LoadValue plus the resolution provenance
// ("tenant" | "env" | "default"). Callers that must treat an org-admin
// value differently from operator configuration need the source, not just
// the value: an env-configured endpoint is the operator's own
// infrastructure, while the same string set through the admin API is
// tenant input and has to clear the outbound safety policy.
func LoadValueWithSource(ctx context.Context, db Querier, orgID, key string) (any, string) {
	def := Get(key)
	if def == nil {
		return nil, ""
	}
	raw, err := store.New(db).GetOrgConfigValue(ctx, store.GetOrgConfigValueParams{
		OrgID: orgID, Key: key,
	})
	tenantRows := map[string]json.RawMessage{}
	if err == nil {
		tenantRows[key] = raw
	}
	return ResolveValue(key, tenantRows, os.LookupEnv)
}

// LoadValues resolves SEVERAL keys with one query. Callers that need more
// than one key must prefer this over repeated LoadValue calls: every
// LoadValue acquires its own pool connection, and a caller that already
// holds an open transaction multiplies that pressure against the worker
// pool budget (concurrency+2, one connection permanently hijacked for
// LISTEN). Read failures degrade to catalog defaults, same as LoadValue —
// config reads must never take the governed operation down.
func LoadValues(ctx context.Context, db Querier, orgID string, keys ...string) map[string]any {
	resolved := LoadValuesWithSources(ctx, db, orgID, keys...)
	values := make(map[string]any, len(resolved))
	for key, item := range resolved {
		values[key] = item.Value
	}
	return values
}

// LoadValuesWithSources resolves several keys and their provenance from one
// tenant-row snapshot. Store failures retain the ordinary fail-soft contract:
// every requested known key resolves from environment/default policy.
func LoadValuesWithSources(ctx context.Context, db Querier, orgID string, keys ...string) map[string]ValueWithSource {
	tenantRows := LoadTenantRows(ctx, db, orgID)
	values := make(map[string]ValueWithSource, len(keys))
	for _, key := range keys {
		value, source := ResolveValue(key, tenantRows, os.LookupEnv)
		values[key] = ValueWithSource{Value: value, Source: source}
	}
	return values
}

// LoadTenantRows reads every tenant-authored row once. Callers that resolve
// several keys over a bounded scope (one claimed node, one sweep of an org)
// hold the map and resolve from it with ResolveValue instead of paying a
// pool round trip per key. A read failure degrades to "no tenant rows".
func LoadTenantRows(ctx context.Context, db Querier, orgID string) map[string]json.RawMessage {
	tenantRows := map[string]json.RawMessage{}
	if rows, err := store.New(db).ListOrgConfigRows(ctx, orgID); err == nil {
		for _, row := range rows {
			tenantRows[row.Key] = row.ValueJson
		}
	}
	return tenantRows
}

// LoadBool is LoadValue for boolean keys.
func LoadBool(ctx context.Context, db Querier, orgID, key string) bool {
	value, _ := LoadValue(ctx, db, orgID, key).(bool)
	return value
}

// LoadNumber is LoadValue for number keys.
func LoadNumber(ctx context.Context, db Querier, orgID, key string) float64 {
	value, _ := LoadValue(ctx, db, orgID, key).(float64)
	return value
}
