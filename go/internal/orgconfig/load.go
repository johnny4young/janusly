// DB-backed snapshot loaders over the pure resolver — the one place
// consumers (start gate, MCP consent, retention windows) read effective
// org settings from, so every surface shares the identical layer chain.
package orgconfig

import (
	"context"
	"encoding/json"
	"os"

	"github.com/johnny4young/janusly/go/internal/store"
)

// Querier is the subset of the store the loaders need — *pgxpool.Pool and
// pgx.Tx both satisfy store.DBTX.
type Querier = store.DBTX

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
	def := Get(key)
	if def == nil {
		return nil
	}
	raw, err := store.New(db).GetOrgConfigValue(ctx, store.GetOrgConfigValueParams{
		OrgID: orgID, Key: key,
	})
	tenantRows := map[string]json.RawMessage{}
	if err == nil {
		tenantRows[key] = raw
	}
	value, _ := ResolveValue(key, tenantRows, os.LookupEnv)
	return value
}

// LoadValues resolves SEVERAL keys with one query. Callers that need more
// than one key must prefer this over repeated LoadValue calls: every
// LoadValue acquires its own pool connection, and a caller that already
// holds an open transaction multiplies that pressure against the worker
// pool budget (concurrency+2, one connection permanently hijacked for
// LISTEN). Read failures degrade to catalog defaults, same as LoadValue —
// config reads must never take the governed operation down.
func LoadValues(ctx context.Context, db Querier, orgID string, keys ...string) map[string]any {
	tenantRows := map[string]json.RawMessage{}
	if rows, err := store.New(db).ListOrgConfigRows(ctx, orgID); err == nil {
		for _, row := range rows {
			tenantRows[row.Key] = row.ValueJson
		}
	}
	values := make(map[string]any, len(keys))
	for _, key := range keys {
		value, _ := ResolveValue(key, tenantRows, os.LookupEnv)
		values[key] = value
	}
	return values
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
