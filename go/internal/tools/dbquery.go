// Postgres DB query tools (reference packages/engine/src/db-query-tools.ts):
// credential-backed access to CUSTOMER-owned databases from workflow tool
// nodes.
//
// Invariants:
//   - The multi-tenant boundary is the org-scoped credential lookup
//     (orgId, kind "postgres", name). Customer SQL is never rewritten to
//     inject tenant predicates; the customer's DSN/role/schema/RLS/views
//     own row-level isolation inside the external DB.
//   - Workflow JSON stores only the credential NAME; the DSN resolves
//     through the Secret Store and neither the reference nor the URL is
//     ever echoed (safeDbError redacts postgres:// URLs + secret shapes).
//   - SQL validation rejects semicolons, comments, DDL/session-control
//     verbs, verb-class mismatches, and placeholder/param mismatches.
//   - Pools are keyed org+credential: max five external pools per
//     org/process, ONE connection each; a rotated DSN (fingerprint
//     change) swaps the pool.
//   - Envelopes never throw; write tools carry WriteSide (dry-run skip).
package tools

import (
	"errors"
	"os"

	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/go/internal/signature"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

const (
	dbMaxOrgPools            = 5
	dbMaxProcessPoolsDefault = 25
	dbMaxRowsDefault         = 100
	dbMaxRowsLimit           = 1_000
	dbMaxTransactionStmts    = 10
	dbMaxIdentifierLength    = 63
	dbSQLTextMax             = 20_000
	dbTimeoutMsDefault       = 30_000
	dbTimeoutMsMax           = 120_000
	dbSchemaDescribeRowLimit = 2_000
	dbDefaultRateLimitPerMin = 60
)

var (
	dbSafeIdentifier   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	dbCommentPattern   = regexp.MustCompile(`--|/\*`)
	dbDangerousPattern = regexp.MustCompile(`(?i)\b(create|alter|drop|truncate|grant|revoke|copy|listen|notify|vacuum|analyze|call|do|execute|prepare|deallocate|reset|show|begin|commit|rollback|savepoint|release)\b`)
	dbPlaceholder      = regexp.MustCompile(`\$(\d+)`)
	dbPostgresURL      = regexp.MustCompile(`(?i)postgres(?:ql)?://\S+`)
)

/* ---------------------------- SQL validation --------------------------- */

// FirstSQLVerb returns the lowercased first token.
func FirstSQLVerb(sql string) string {
	fields := strings.Fields(strings.TrimSpace(sql))
	if len(fields) == 0 {
		return ""
	}
	return strings.ToLower(fields[0])
}

func isWriteVerb(verb string) bool {
	return verb == "insert" || verb == "update" || verb == "delete"
}

// ValidateDbSQL enforces the closed statement grammar for one statement.
// kind: "read" | "write" | "any".
func ValidateDbSQL(sql string, paramsLen int, kind string) string {
	trimmed := strings.TrimSpace(sql)
	if trimmed == "" {
		return "sql is required"
	}
	if len(trimmed) > dbSQLTextMax {
		return "sql is too large"
	}
	if strings.Contains(trimmed, ";") {
		return "sql must contain exactly one statement and no semicolon"
	}
	if dbCommentPattern.MatchString(trimmed) {
		return "sql comments are not allowed"
	}
	if dbDangerousPattern.MatchString(trimmed) {
		return "sql verb is not allowed"
	}
	verb := FirstSQLVerb(trimmed)
	switch kind {
	case "read":
		if verb != "select" {
			return "db.query.read only accepts SELECT statements"
		}
	case "write":
		if !isWriteVerb(verb) {
			return "db.query.write only accepts INSERT, UPDATE, or DELETE statements"
		}
	default:
		if verb != "select" && !isWriteVerb(verb) {
			return "transactions accept only SELECT, INSERT, UPDATE, or DELETE statements"
		}
	}
	return validateDbPlaceholders(trimmed, paramsLen)
}

func validateDbPlaceholders(sql string, paramsLen int) string {
	seen := map[int]bool{}
	max := 0
	for _, match := range dbPlaceholder.FindAllStringSubmatch(sql, -1) {
		n, err := strconv.Atoi(match[1])
		if err != nil || n <= 0 {
			return "sql placeholders must start at $1"
		}
		seen[n] = true
		if n > max {
			max = n
		}
	}
	for i := 1; i <= max; i++ {
		if !seen[i] {
			return "sql placeholders must be contiguous from $1"
		}
	}
	if paramsLen != max {
		return fmt.Sprintf("params length (%d) must match highest placeholder ($%d)", paramsLen, max)
	}
	return ""
}

/* ------------------------------ pool cache ----------------------------- */

type dbPoolEntry struct {
	pool        *pgxpool.Pool
	orgID       string
	fingerprint string
	touchedAt   time.Time
}

var (
	dbPoolsMu sync.Mutex
	dbPools   = map[string]*dbPoolEntry{}
)

// errDbPoolExhausted is the stable never-throw sentinel: at the process
// cap the tool answers {ok:false, error:"db_pool_exhausted"} (T-513).
var errDbPoolExhausted = errors.New("db_pool_exhausted")

// metricDbToolPools gauges the live external-pool count for dashboards.
var metricDbToolPools = promauto.NewGauge(prometheus.GaugeOpts{
	Name: "janusly_go_db_tool_pools",
	Help: "Cached external db-tool connection pools in this process.",
})

// dbMaxProcessPools resolves the PROCESS-wide external-pool cap: env
// JANUSLY_GO_DB_TOOL_MAX_PROCESS_POOLS (1..500) or the default 25. One
// noisy tenant can exhaust its own 5-pool budget, never the process.
func dbMaxProcessPools() int {
	if raw := os.Getenv("JANUSLY_GO_DB_TOOL_MAX_PROCESS_POOLS"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n >= 1 && n <= 500 {
			return n
		}
	}
	return dbMaxProcessPoolsDefault
}

// ResetDbPoolsForTests closes and forgets every cached external pool.
func ResetDbPoolsForTests() {
	dbPoolsMu.Lock()
	defer dbPoolsMu.Unlock()
	for key, entry := range dbPools {
		entry.pool.Close()
		delete(dbPools, key)
	}
	metricDbToolPools.Set(0)
}

// getDbPool caches ONE-connection pools per (org, credential), swapping on
// a DSN fingerprint change and evicting the org's LRU pool past the cap.
func getDbPool(ctx context.Context, orgID, credentialName, dsn string) (*pgxpool.Pool, error) {
	key := orgID + "\x00" + credentialName
	digest := sha256.Sum256([]byte(dsn))
	fingerprint := hex.EncodeToString(digest[:])

	dbPoolsMu.Lock()
	defer dbPoolsMu.Unlock()
	if existing, ok := dbPools[key]; ok {
		if existing.fingerprint == fingerprint {
			existing.touchedAt = time.Now()
			return existing.pool, nil
		}
		existing.pool.Close()
		delete(dbPools, key)
	}
	// Evict the org's least-recently-used pool past the cap.
	var orgKeys []string
	for candidateKey, entry := range dbPools {
		if entry.orgID == orgID {
			orgKeys = append(orgKeys, candidateKey)
		}
	}
	if len(orgKeys) >= dbMaxOrgPools {
		sort.Slice(orgKeys, func(a, b int) bool {
			return dbPools[orgKeys[a]].touchedAt.Before(dbPools[orgKeys[b]].touchedAt)
		})
		oldest := orgKeys[0]
		dbPools[oldest].pool.Close()
		delete(dbPools, oldest)
	}
	// Process-wide semaphore over the TOTAL (T-513): a net-new pool past
	// the cap answers the stable exhausted sentinel instead of growing —
	// deliberately NO cross-org eviction, so one tenant cannot thrash
	// another tenant's warm pools.
	if len(dbPools) >= dbMaxProcessPools() {
		return nil, errDbPoolExhausted
	}

	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("invalid postgres credential value")
	}
	config.MaxConns = 1
	config.ConnConfig.ConnectTimeout = 10 * time.Second
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("could not open external database pool")
	}
	dbPools[key] = &dbPoolEntry{pool: pool, orgID: orgID, fingerprint: fingerprint, touchedAt: time.Now()}
	metricDbToolPools.Set(float64(len(dbPools)))
	return pool, nil
}

/* ------------------------------ shaping -------------------------------- */

func dbJSONSafe(value any) any {
	switch typed := value.(type) {
	case time.Time:
		return typed.UTC().Format(time.RFC3339Nano)
	case []byte:
		return base64.StdEncoding.EncodeToString(typed)
	case [16]byte: // uuid
		return hex.EncodeToString(typed[:])
	default:
		return value
	}
}

func collectDbRows(rows pgx.Rows, maxRows int) ([]any, bool, error) {
	fieldDescriptions := rows.FieldDescriptions()
	collected := make([]any, 0, maxRows)
	truncated := false
	for rows.Next() {
		if len(collected) >= maxRows {
			truncated = true
			break
		}
		values, err := rows.Values()
		if err != nil {
			return nil, false, err
		}
		record := map[string]any{}
		for index, field := range fieldDescriptions {
			record[string(field.Name)] = dbJSONSafe(values[index])
		}
		collected = append(collected, record)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	return collected, truncated, nil
}

// safeDbError redacts connection URLs and secret shapes; never empty.
func safeDbError(err error) string {
	raw := "database query failed"
	if err != nil && err.Error() != "" {
		raw = err.Error()
	}
	scrubbed := strings.TrimSpace(signature.ScrubSecretShapes(dbPostgresURL.ReplaceAllString(raw, "[REDACTED_POSTGRES_URL]")))
	if scrubbed == "" {
		return "database query failed"
	}
	if len(scrubbed) > 300 {
		return scrubbed[:300] + "…"
	}
	return scrubbed
}

/* --------------------------- catalog entries --------------------------- */

func dbTools() []Definition {
	unavailable := func(_ context.Context, _ map[string]any) (map[string]any, error) {
		return map[string]any{"ok": false, "error": "integration tools require run context", "latencyMs": 0}, nil
	}
	return []Definition{
		{
			Name:        "db.schema.describe",
			Description: "Describe tables and columns from a stored Postgres credential without running arbitrary SQL.",
			Required:    []string{"credential"},
			Optional:    []string{"schema", "tables"},
			Fields: []Field{
				{Name: "credential", Type: "string", Required: true},
				{Name: "schema", Type: "string"},
				{Name: "tables", Type: "array"},
			},
			InputExample: map[string]any{"credential": "customer-postgres", "schema": "public", "tables": []any{"customers"}},
			Execute:      unavailable,
		},
		{
			Name:        "db.query.read",
			Description: "Run a parameterized SELECT against a stored Postgres credential and return bounded rows.",
			Required:    []string{"credential", "sql"},
			Optional:    []string{"params", "maxRows", "timeoutMs"},
			Fields: []Field{
				{Name: "credential", Type: "string", Required: true},
				{Name: "sql", Type: "string", Required: true},
				{Name: "params", Type: "array"},
				{Name: "maxRows", Type: "number"},
				{Name: "timeoutMs", Type: "number"},
			},
			InputExample: map[string]any{
				"credential": "customer-postgres",
				"sql":        "select id, email from customers where status = $1", "params": []any{"active"},
			},
			Execute: unavailable,
		},
		{
			Name:        "db.query.write",
			Description: "Run one parameterized INSERT, UPDATE, or DELETE against a stored Postgres credential.",
			Required:    []string{"credential", "sql"},
			Optional:    []string{"params", "maxRows", "timeoutMs"},
			Fields: []Field{
				{Name: "credential", Type: "string", Required: true},
				{Name: "sql", Type: "string", Required: true},
				{Name: "params", Type: "array"},
				{Name: "maxRows", Type: "number"},
				{Name: "timeoutMs", Type: "number"},
			},
			InputExample: map[string]any{
				"credential": "customer-postgres",
				"sql":        "update customers set status = $1 where id = $2", "params": []any{"active", "cus_123"},
			},
			WriteSide: true,
			Execute:   unavailable,
		},
		{
			Name:        "db.query.transaction",
			Description: "Run a bounded transaction of parameterized Postgres SELECT/DML statements through a stored credential.",
			Required:    []string{"credential", "statements"},
			Optional:    []string{"maxRowsPerStatement", "timeoutMs"},
			Fields: []Field{
				{Name: "credential", Type: "string", Required: true},
				{Name: "statements", Type: "array", Required: true},
				{Name: "maxRowsPerStatement", Type: "number"},
				{Name: "timeoutMs", Type: "number"},
			},
			InputExample: map[string]any{
				"credential": "customer-postgres",
				"statements": []any{
					map[string]any{"sql": "update customers set status = $1 where id = $2", "params": []any{"active", "cus_123"}},
					map[string]any{"sql": "select id, status from customers where id = $1", "params": []any{"cus_123"}},
				},
			},
			WriteSide: true,
			Execute:   unavailable,
		},
	}
}

/* ------------------------------ execution ------------------------------ */

type dbStatement struct {
	sql    string
	params []any
}

func dbBoundedInt(input map[string]any, key string, fallback, max int) (int, string) {
	raw, present := input[key]
	if !present {
		return fallback, ""
	}
	value, ok := raw.(float64)
	if !ok || value != math.Trunc(value) || value < 1 || value > float64(max) {
		return 0, key + " out of range"
	}
	return int(value), ""
}

// executeDbTool dispatches the four db.* tools through the chokepoint.
func executeDbTool(ctx context.Context, name string, input map[string]any, deps *IntegrationDeps) map[string]any {
	start := time.Now()
	latency := func() int { return int(time.Since(start).Milliseconds()) }
	credential, _ := input["credential"].(string)
	if credential == "" {
		return envelopeError(name+" requires credential", latency())
	}
	record := func(ok bool, errMessage string) {
		if deps != nil && deps.Record != nil {
			deps.Record(name, credential, ok, 0, errMessage, latency())
		}
	}
	answerError := func(message string) map[string]any {
		record(false, message)
		return envelopeError(message, latency())
	}
	if deps == nil || deps.Gate == nil {
		return envelopeError("integration tools require run context", latency())
	}

	maxRowsKey := "maxRows"
	if name == "db.query.transaction" {
		maxRowsKey = "maxRowsPerStatement"
	}
	maxRows, boundError := dbBoundedInt(input, maxRowsKey, dbMaxRowsDefault, dbMaxRowsLimit)
	if boundError != "" {
		return answerError(boundError)
	}
	timeoutMs, boundError := dbBoundedInt(input, "timeoutMs", dbTimeoutMsDefault, dbTimeoutMsMax)
	if boundError != "" {
		return answerError(boundError)
	}

	// Validate BEFORE the gate — bad SQL must not consume rate budget.
	var statements []dbStatement
	switch name {
	case "db.schema.describe":
		if schema, present := input["schema"].(string); present && !dbSafeIdentifier.MatchString(schema) {
			return answerError("schema must be a simple Postgres identifier")
		}
		if rawTables, present := input["tables"].([]any); present {
			if len(rawTables) > 50 {
				return answerError("tables allows at most 50 names")
			}
			for _, rawTable := range rawTables {
				table, ok := rawTable.(string)
				if !ok || len(table) > dbMaxIdentifierLength || !dbSafeIdentifier.MatchString(table) {
					return answerError("table names must be simple Postgres identifiers")
				}
			}
		}
	case "db.query.read", "db.query.write":
		sql, _ := input["sql"].(string)
		params, _ := input["params"].([]any)
		if len(params) > 100 {
			return answerError("params allows at most 100 values")
		}
		kind := "read"
		if name == "db.query.write" {
			kind = "write"
		}
		if message := ValidateDbSQL(sql, len(params), kind); message != "" {
			return answerError(message)
		}
		statements = []dbStatement{{sql: strings.TrimSpace(sql), params: params}}
	case "db.query.transaction":
		rawStatements, ok := input["statements"].([]any)
		if !ok || len(rawStatements) == 0 || len(rawStatements) > dbMaxTransactionStmts {
			return answerError(fmt.Sprintf("statements must list 1..%d entries", dbMaxTransactionStmts))
		}
		for _, rawStatement := range rawStatements {
			entry, ok := rawStatement.(map[string]any)
			if !ok {
				return answerError("statements entries must be objects")
			}
			sql, _ := entry["sql"].(string)
			params, _ := entry["params"].([]any)
			if len(params) > 100 {
				return answerError("params allows at most 100 values")
			}
			if message := ValidateDbSQL(sql, len(params), "any"); message != "" {
				return answerError(message)
			}
			statements = append(statements, dbStatement{sql: strings.TrimSpace(sql), params: params})
		}
	}

	rateLimit := dbDefaultRateLimitPerMin
	if deps.RateLimitPerMin != nil {
		rateLimit = deps.RateLimitPerMin("db", dbDefaultRateLimitPerMin)
	}
	dsn, gateError := deps.Gate(ctx, name, "postgres", credential, rateLimit)
	if gateError != "" {
		return answerError(gateError)
	}
	orgID := ""
	if deps.OrgID != nil {
		orgID = deps.OrgID()
	}
	pool, err := getDbPool(ctx, orgID, credential, dsn)
	if err != nil {
		return answerError(safeDbError(err))
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return answerError(safeDbError(err))
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, fmt.Sprintf("set local statement_timeout = %d", timeoutMs)); err != nil {
		return answerError(safeDbError(err))
	}

	switch name {
	case "db.schema.describe":
		schema, _ := input["schema"].(string)
		rawTables, _ := input["tables"].([]any)
		sql, params := buildSchemaDescribeQuery(schema, rawTables)
		rows, err := tx.Query(ctx, sql, params...)
		if err != nil {
			return answerError(safeDbError(err))
		}
		collected, _, err := collectDbRows(rows, dbSchemaDescribeRowLimit+1)
		if err != nil {
			return answerError(safeDbError(err))
		}
		if err := tx.Commit(ctx); err != nil {
			return answerError(safeDbError(err))
		}
		truncated := len(collected) > dbSchemaDescribeRowLimit
		if truncated {
			collected = collected[:dbSchemaDescribeRowLimit]
		}
		record(true, "")
		return map[string]any{"ok": true, "tables": shapeSchemaRows(collected), "truncated": truncated, "latencyMs": latency()}

	case "db.query.read":
		statement := statements[0]
		wrapped := fmt.Sprintf("select * from (%s) as janusly_db_query limit %d", statement.sql, maxRows+1)
		rows, err := tx.Query(ctx, wrapped, statement.params...)
		if err != nil {
			return answerError(safeDbError(err))
		}
		collected, truncated, err := collectDbRows(rows, maxRows)
		if err != nil {
			return answerError(safeDbError(err))
		}
		if err := tx.Commit(ctx); err != nil {
			return answerError(safeDbError(err))
		}
		record(true, "")
		return map[string]any{"ok": true, "rows": collected, "rowCount": len(collected), "truncated": truncated, "latencyMs": latency()}

	case "db.query.write":
		statement := statements[0]
		rows, err := tx.Query(ctx, statement.sql, statement.params...)
		if err != nil {
			return answerError(safeDbError(err))
		}
		collected, truncated, err := collectDbRows(rows, maxRows)
		if err != nil {
			return answerError(safeDbError(err))
		}
		rowCount := len(collected)
		commandTag := rows.CommandTag()
		if commandTag.RowsAffected() > 0 && rowCount == 0 {
			rowCount = int(commandTag.RowsAffected())
		}
		if err := tx.Commit(ctx); err != nil {
			return answerError(safeDbError(err))
		}
		record(true, "")
		return map[string]any{"ok": true, "rows": collected, "rowCount": rowCount, "truncated": truncated, "latencyMs": latency()}

	default: // db.query.transaction
		results := make([]any, 0, len(statements))
		for _, statement := range statements {
			sql := statement.sql
			if FirstSQLVerb(sql) == "select" {
				sql = fmt.Sprintf("select * from (%s) as janusly_db_query limit %d", sql, maxRows+1)
			}
			rows, err := tx.Query(ctx, sql, statement.params...)
			if err != nil {
				return answerError(safeDbError(err))
			}
			collected, truncated, err := collectDbRows(rows, maxRows)
			if err != nil {
				return answerError(safeDbError(err))
			}
			rowCount := len(collected)
			if tag := rows.CommandTag(); tag.RowsAffected() > 0 && rowCount == 0 {
				rowCount = int(tag.RowsAffected())
			}
			results = append(results, map[string]any{"rows": collected, "rowCount": rowCount, "truncated": truncated})
		}
		if err := tx.Commit(ctx); err != nil {
			return answerError(safeDbError(err))
		}
		record(true, "")
		return map[string]any{"ok": true, "results": results, "latencyMs": latency()}
	}
}

func buildSchemaDescribeQuery(schema string, rawTables []any) (string, []any) {
	params := []any{}
	clauses := []string{"table_schema not in ('pg_catalog', 'information_schema')"}
	if schema != "" {
		params = append(params, schema)
		clauses = append(clauses, fmt.Sprintf("table_schema = $%d", len(params)))
	}
	if len(rawTables) > 0 {
		tables := make([]string, 0, len(rawTables))
		for _, rawTable := range rawTables {
			if table, ok := rawTable.(string); ok {
				tables = append(tables, table)
			}
		}
		params = append(params, tables)
		clauses = append(clauses, fmt.Sprintf("table_name = any($%d::text[])", len(params)))
	}
	sql := fmt.Sprintf(`select table_schema, table_name, column_name, data_type, is_nullable, ordinal_position
from information_schema.columns
where %s
order by table_schema, table_name, ordinal_position
limit %d`, strings.Join(clauses, " and "), dbSchemaDescribeRowLimit+1)
	return sql, params
}

func shapeSchemaRows(rows []any) []any {
	type tableShape struct {
		schema  string
		name    string
		columns []any
	}
	order := []string{}
	byTable := map[string]*tableShape{}
	for _, rawRow := range rows {
		row, ok := rawRow.(map[string]any)
		if !ok {
			continue
		}
		schema := fmt.Sprint(row["table_schema"])
		name := fmt.Sprint(row["table_name"])
		key := schema + "\x00" + name
		table, present := byTable[key]
		if !present {
			table = &tableShape{schema: schema, name: name}
			byTable[key] = table
			order = append(order, key)
		}
		ordinal := 0.0
		if value, ok := row["ordinal_position"].(float64); ok {
			ordinal = value
		} else if value, ok := row["ordinal_position"].(int32); ok {
			ordinal = float64(value)
		}
		table.columns = append(table.columns, map[string]any{
			"name":            fmt.Sprint(row["column_name"]),
			"type":            fmt.Sprint(row["data_type"]),
			"nullable":        row["is_nullable"] == "YES",
			"ordinalPosition": ordinal,
		})
	}
	out := make([]any, 0, len(order))
	for _, key := range order {
		out = append(out, map[string]any{
			"schema": byTable[key].schema, "name": byTable[key].name, "columns": byTable[key].columns,
		})
	}
	return out
}
