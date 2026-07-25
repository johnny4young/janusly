/**
 * Postgres DB query tools — credential-backed access to customer-owned
 * databases from workflow `tool` nodes.
 *
 * Used by:
 * - `packages/engine/src/tool-registry.ts` — registers the public
 *   `db.schema.describe`, `db.query.read`, `db.query.write`, and
 *   `db.query.transaction` tools.
 *
 * Invariants:
 * - Multi-tenant boundary is the Janusly org-scoped credential lookup:
 *   `(orgId, kind: "postgres", credentialName)`. We do not rewrite customer
 *   SQL to inject tenant predicates; the customer-provided DSN / DB role /
 *   schema / RLS / views own row-level isolation inside the external DB.
 * - Workflow JSON stores only an operator-friendly credential name. The real
 *   Postgres URL resolves through the central SecretStore (with legacy env
 *   references supported), and neither the reference nor URL is returned.
 * - Runtime failures return `{ ok: false, error, latencyMs }` envelopes and
 *   never throw. Validation failures are likewise surfaced as envelopes so a
 *   workflow can branch on `ok`.
 */

import { createHash } from "node:crypto";
import postgres from "postgres";
import { z } from "zod";

import { getCredentialByName, resolveCredentialSecretRef } from "@janusly/data";
import { scrubSecretShapes } from "@janusly/shared/src/error-signature";
import { RATE_LIMIT_WINDOW_MS } from "./constants";
import { getIntegrationUsageRecorder } from "./integration-usage";
import { getEngineRateLimiter } from "./rate-limit";
import type { ToolExecutionContext } from "./tool-registry";

const POSTGRES_CREDENTIAL_KIND = "postgres";
const DEFAULT_DB_RATE_LIMIT_PER_MIN = 60;
const MAX_ORG_DB_POOLS = 5;
const MAX_ROWS_DEFAULT = 100;
const MAX_ROWS_LIMIT = 1_000;
const MAX_TRANSACTION_STATEMENTS = 10;
const MAX_IDENTIFIER_LENGTH = 63;
const SQL_TEXT_MAX = 20_000;
const DB_QUERY_TIMEOUT_MS_DEFAULT = 30_000;
const DB_QUERY_TIMEOUT_MS_MAX = 120_000;
const SCHEMA_DESCRIBE_ROW_LIMIT = 2_000;
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SQL_COMMENT_PATTERN = /--|\/\*/;
const DANGEROUS_SQL_WORD_PATTERN = /\b(create|alter|drop|truncate|grant|revoke|copy|listen|notify|vacuum|analyze|call|do|execute|prepare|deallocate|reset|show|begin|commit|rollback|savepoint|release)\b/i;

const dbParam = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

const dbCredentialInput = z.object({
  /** Stored credential name (kind: `postgres`). The env-backed value is a Postgres URL. */
  credential: z.string().min(1),
});

const boundedRowsInput = {
  /** Maximum result rows returned in the tool envelope. Defaults to 100, max 1000. */
  maxRows: z.number().int().min(1).max(MAX_ROWS_LIMIT).optional(),
  /** Statement timeout in milliseconds. Defaults to 30000, max 120000. */
  timeoutMs: z.number().int().min(1).max(DB_QUERY_TIMEOUT_MS_MAX).optional(),
};

const sqlStatementInput = {
  /** Parameterized SQL using Postgres placeholders (`$1`, `$2`, ...). */
  sql: z.string().min(1).max(SQL_TEXT_MAX),
  /** Values for SQL placeholders. `params.length` must equal the highest placeholder number. */
  params: z.array(dbParam).max(100).optional(),
};

export const dbSchemaDescribeInput = dbCredentialInput.extend({
  /** Optional schema to inspect. Defaults to all non-system schemas. */
  schema: z.string().min(1).max(MAX_IDENTIFIER_LENGTH).optional(),
  /** Optional table-name allowlist. */
  tables: z.array(z.string().min(1).max(MAX_IDENTIFIER_LENGTH)).max(50).optional(),
});

const dbColumnOutput = z.object({
  name: z.string(),
  type: z.string(),
  nullable: z.boolean(),
  ordinalPosition: z.number(),
});

const dbTableOutput = z.object({
  schema: z.string(),
  name: z.string(),
  columns: z.array(dbColumnOutput),
});

export const dbSchemaDescribeOutput = z.object({
  ok: z.boolean(),
  tables: z.array(dbTableOutput).optional(),
  truncated: z.boolean().optional(),
  error: z.string().optional(),
  latencyMs: z.number(),
});

export const dbQueryReadInput = dbCredentialInput.extend({
  ...sqlStatementInput,
  ...boundedRowsInput,
});

export const dbQueryReadOutput = z.object({
  ok: z.boolean(),
  rows: z.array(z.record(z.string(), z.unknown())).optional(),
  rowCount: z.number().optional(),
  truncated: z.boolean().optional(),
  error: z.string().optional(),
  latencyMs: z.number(),
});

export const dbQueryWriteInput = dbCredentialInput.extend({
  ...sqlStatementInput,
  ...boundedRowsInput,
});

export const dbQueryWriteOutput = z.object({
  ok: z.boolean(),
  rows: z.array(z.record(z.string(), z.unknown())).optional(),
  rowCount: z.number().optional(),
  truncated: z.boolean().optional(),
  error: z.string().optional(),
  latencyMs: z.number(),
});

const transactionStatementInput = z.object({
  ...sqlStatementInput,
});

export const dbQueryTransactionInput = dbCredentialInput.extend({
  statements: z.array(transactionStatementInput).min(1).max(MAX_TRANSACTION_STATEMENTS),
  maxRowsPerStatement: z.number().int().min(1).max(MAX_ROWS_LIMIT).optional(),
  timeoutMs: z.number().int().min(1).max(DB_QUERY_TIMEOUT_MS_MAX).optional(),
});

export const dbQueryTransactionOutput = z.object({
  ok: z.boolean(),
  results: z.array(z.object({
    rows: z.array(z.record(z.string(), z.unknown())).optional(),
    rowCount: z.number(),
    truncated: z.boolean().optional(),
  })).optional(),
  error: z.string().optional(),
  latencyMs: z.number(),
});

type DbToolName = "db.schema.describe" | "db.query.read" | "db.query.write" | "db.query.transaction";
type StatementKind = "read" | "write" | "any";
type ExternalDbRows = Array<Record<string, unknown>> & { count?: number; command?: string };
type ExternalDbRunner = {
  unsafe(sql: string, params?: unknown[]): Promise<ExternalDbRows>;
};
type ExternalDbClient = ExternalDbRunner & {
  begin<T>(handler: (tx: ExternalDbRunner) => Promise<T>): Promise<T>;
  end(options?: { timeout?: number }): Promise<void>;
};
type ExternalDbClientFactory = (connectionString: string) => ExternalDbClient;

type ClientEntry = {
  client: ExternalDbClient;
  orgId: string;
  credentialName: string;
  fingerprint: string;
  touchedAt: number;
};

const clients = new Map<string, ClientEntry>();
let clientFactory: ExternalDbClientFactory = defaultClientFactory;

function defaultClientFactory(connectionString: string): ExternalDbClient {
  return postgres(connectionString, {
    // One connection per credential pool + at most five pools per org gives
    // a hard per-process upper bound of five external DB connections per org.
    max: 1,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => undefined,
  }) as unknown as ExternalDbClient;
}

/** Test seam for fake Postgres clients. Production never calls this. */
export function _setExternalDbClientFactoryForTests(factory: ExternalDbClientFactory | null): void {
  clientFactory = factory ?? defaultClientFactory;
}

/** Close and forget cached external DB pools. Production calls this only via tests. */
export async function _resetExternalDbClientsForTests(): Promise<void> {
  const entries = [...clients.values()];
  clients.clear();
  await Promise.all(entries.map((entry) => entry.client.end({ timeout: 1 }).catch(() => undefined)));
  clientFactory = defaultClientFactory;
}

type GateOk = { ok: true; client: ExternalDbClient };
type GateErr = { ok: false; error: string };

async function gateDbCall(args: {
  orgId: string | undefined;
  credentialName: string;
  tool: DbToolName;
  rateLimitPerMin: number;
}): Promise<GateOk | GateErr> {
  if (!args.orgId) {
    return { ok: false, error: `${args.tool} requires multi-tenant context` };
  }

  let credential: Awaited<ReturnType<typeof getCredentialByName>>;
  try {
    credential = await getCredentialByName(args.orgId, POSTGRES_CREDENTIAL_KIND, args.credentialName);
  } catch (err) {
    return { ok: false, error: safeRuntimeError(err) };
  }
  if (!credential) {
    return { ok: false, error: `credential not found: ${args.credentialName}` };
  }

  const secret = await resolveCredentialSecretRef(args.orgId, credential.secretRef);
  if (!secret) {
    return { ok: false, error: `credential secret missing for ${args.credentialName}` };
  }

  const limiter = getEngineRateLimiter();
  if (limiter) {
    try {
      await limiter(dbRateLimitBucket(args.tool, args.credentialName), args.orgId, {
        windowMs: RATE_LIMIT_WINDOW_MS,
        max: args.rateLimitPerMin,
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Rate limit exceeded" };
    }
  }

  try {
    return { ok: true, client: getClient(args.orgId, args.credentialName, secret) };
  } catch (err) {
    return { ok: false, error: safeRuntimeError(err) };
  }
}

function getClient(orgId: string, credentialName: string, connectionString: string): ExternalDbClient {
  const key = poolKey(orgId, credentialName);
  const fingerprint = createHash("sha256").update(connectionString).digest("hex");
  const existing = clients.get(key);
  if (existing && existing.fingerprint === fingerprint) {
    existing.touchedAt = Date.now();
    return existing.client;
  }
  if (existing) {
    clients.delete(key);
    existing.client.end({ timeout: 1 }).catch(() => undefined);
  }

  evictOrgPoolIfNeeded(orgId);
  const client = clientFactory(connectionString);
  clients.set(key, {
    client,
    orgId,
    credentialName,
    fingerprint,
    touchedAt: Date.now(),
  });
  return client;
}

function poolKey(orgId: string, credentialName: string): string {
  return `${orgId}\u0000${credentialName}`;
}

function dbRateLimitBucket(tool: DbToolName, credentialName: string): string {
  const credentialHash = createHash("sha256").update(credentialName).digest("hex").slice(0, 16);
  return `tool.${tool}.${credentialHash}`;
}

function evictOrgPoolIfNeeded(orgId: string): void {
  const orgEntries = [...clients.entries()].filter(([, entry]) => entry.orgId === orgId);
  if (orgEntries.length < MAX_ORG_DB_POOLS) return;
  orgEntries.sort((a, b) => a[1].touchedAt - b[1].touchedAt);
  const [key, entry] = orgEntries[0]!;
  clients.delete(key);
  entry.client.end({ timeout: 1 }).catch(() => undefined);
}

async function fireUsage(input: {
  orgId: string | undefined;
  tool: DbToolName;
  credentialName: string;
  executionContext: ToolExecutionContext;
  ok: boolean;
  error?: string;
  latencyMs: number;
}): Promise<void> {
  if (!input.orgId) return;
  const recorder = getIntegrationUsageRecorder();
  if (!recorder) return;
  try {
    await recorder({
      orgId: input.orgId,
      tool: input.tool,
      credentialName: input.credentialName,
      runId: input.executionContext.runId,
      nodeId: input.executionContext.nodeId,
      workflowId: input.executionContext.workflowId,
      ok: input.ok,
      error: input.error,
      latencyMs: input.latencyMs,
    });
  } catch {
    // Telemetry must never break a tool path.
  }
}

export const dbSchemaDescribeTool = {
  name: "db.schema.describe" as const,
  description: "Describe tables and columns from a stored Postgres credential without running arbitrary SQL.",
  inputSchema: dbSchemaDescribeInput,
  outputSchema: dbSchemaDescribeOutput,
  inputExample: { credential: "customer-postgres", schema: "public", tables: ["customers"] },
  async execute(
    input: z.infer<typeof dbSchemaDescribeInput>,
    _context: Record<string, unknown>,
    executionContext: ToolExecutionContext,
  ): Promise<z.infer<typeof dbSchemaDescribeOutput>> {
    const start = Date.now();
    const tool = "db.schema.describe" as const;
    const orgId = executionContext.orgId;
    const rateLimitPerMin = executionContext.integrations?.db?.rateLimitPerMin
      ?? envPositiveInt("JANUSLY_DB_TOOL_RATE_LIMIT_PER_MIN", DEFAULT_DB_RATE_LIMIT_PER_MIN);

    const invalidIdentifiers = validateDescribeIdentifiers(input.schema, input.tables);
    if (invalidIdentifiers) {
      const latencyMs = Date.now() - start;
      await fireUsage({ orgId, tool, credentialName: input.credential, executionContext, ok: false, error: invalidIdentifiers, latencyMs });
      return { ok: false, error: invalidIdentifiers, latencyMs };
    }

    const gate = await gateDbCall({ orgId, credentialName: input.credential, tool, rateLimitPerMin });
    if (!gate.ok) {
      const latencyMs = Date.now() - start;
      await fireUsage({ orgId, tool, credentialName: input.credential, executionContext, ok: false, error: gate.error, latencyMs });
      return { ok: false, error: gate.error, latencyMs };
    }

    try {
      const { sql, params } = buildSchemaDescribeQuery(input.schema, input.tables);
      // Bound the metadata read the same way the query tools bound theirs: a
      // SET LOCAL statement_timeout inside a transaction caps a pathological
      // information_schema scan (lock contention / a slow upstream) instead of
      // letting it pin a worker until the socket dies.
      const rows = await gate.client.begin(async (tx) => {
        await setLocalStatementTimeout(tx, undefined);
        return tx.unsafe(sql, params);
      });
      const tables = shapeSchemaRows(rows);
      const truncated = rows.length > SCHEMA_DESCRIBE_ROW_LIMIT;
      const latencyMs = Date.now() - start;
      await fireUsage({ orgId, tool, credentialName: input.credential, executionContext, ok: true, latencyMs });
      return { ok: true, tables, truncated, latencyMs };
    } catch (err) {
      const error = safeRuntimeError(err);
      const latencyMs = Date.now() - start;
      await fireUsage({ orgId, tool, credentialName: input.credential, executionContext, ok: false, error, latencyMs });
      return { ok: false, error, latencyMs };
    }
  },
};

export const dbQueryReadTool = {
  name: "db.query.read" as const,
  description: "Run a parameterized SELECT against a stored Postgres credential and return bounded rows.",
  inputSchema: dbQueryReadInput,
  outputSchema: dbQueryReadOutput,
  inputExample: { credential: "customer-postgres", sql: "select id, email from customers where status = $1", params: ["active"] },
  async execute(
    input: z.infer<typeof dbQueryReadInput>,
    _context: Record<string, unknown>,
    executionContext: ToolExecutionContext,
  ): Promise<z.infer<typeof dbQueryReadOutput>> {
    const start = Date.now();
    const tool = "db.query.read" as const;
    const orgId = executionContext.orgId;
    const rateLimitPerMin = executionContext.integrations?.db?.rateLimitPerMin
      ?? envPositiveInt("JANUSLY_DB_TOOL_RATE_LIMIT_PER_MIN", DEFAULT_DB_RATE_LIMIT_PER_MIN);
    const validation = validateSql(input.sql, input.params ?? [], "read");
    if (!validation.ok) {
      const latencyMs = Date.now() - start;
      await fireUsage({ orgId, tool, credentialName: input.credential, executionContext, ok: false, error: validation.error, latencyMs });
      return { ok: false, error: validation.error, latencyMs };
    }

    const gate = await gateDbCall({ orgId, credentialName: input.credential, tool, rateLimitPerMin });
    if (!gate.ok) {
      const latencyMs = Date.now() - start;
      await fireUsage({ orgId, tool, credentialName: input.credential, executionContext, ok: false, error: gate.error, latencyMs });
      return { ok: false, error: gate.error, latencyMs };
    }

    try {
      const maxRows = input.maxRows ?? MAX_ROWS_DEFAULT;
      const rows = await gate.client.begin(async (tx) => {
        await setLocalStatementTimeout(tx, input.timeoutMs);
        return tx.unsafe(wrapReadSql(input.sql, maxRows), input.params ?? []);
      });
      const shaped = shapeRows(rows, maxRows);
      const latencyMs = Date.now() - start;
      await fireUsage({ orgId, tool, credentialName: input.credential, executionContext, ok: true, latencyMs });
      return { ok: true, ...shaped, latencyMs };
    } catch (err) {
      const error = safeRuntimeError(err);
      const latencyMs = Date.now() - start;
      await fireUsage({ orgId, tool, credentialName: input.credential, executionContext, ok: false, error, latencyMs });
      return { ok: false, error, latencyMs };
    }
  },
};

export const dbQueryWriteTool = {
  name: "db.query.write" as const,
  description: "Run one parameterized INSERT, UPDATE, or DELETE against a stored Postgres credential.",
  inputSchema: dbQueryWriteInput,
  outputSchema: dbQueryWriteOutput,
  inputExample: { credential: "customer-postgres", sql: "update customers set status = $1 where id = $2", params: ["active", "cus_123"] },
  writeSide: true as const,
  async execute(
    input: z.infer<typeof dbQueryWriteInput>,
    _context: Record<string, unknown>,
    executionContext: ToolExecutionContext,
  ): Promise<z.infer<typeof dbQueryWriteOutput>> {
    const start = Date.now();
    const tool = "db.query.write" as const;
    const orgId = executionContext.orgId;
    const rateLimitPerMin = executionContext.integrations?.db?.rateLimitPerMin
      ?? envPositiveInt("JANUSLY_DB_TOOL_RATE_LIMIT_PER_MIN", DEFAULT_DB_RATE_LIMIT_PER_MIN);
    const validation = validateSql(input.sql, input.params ?? [], "write");
    if (!validation.ok) {
      const latencyMs = Date.now() - start;
      await fireUsage({ orgId, tool, credentialName: input.credential, executionContext, ok: false, error: validation.error, latencyMs });
      return { ok: false, error: validation.error, latencyMs };
    }

    const gate = await gateDbCall({ orgId, credentialName: input.credential, tool, rateLimitPerMin });
    if (!gate.ok) {
      const latencyMs = Date.now() - start;
      await fireUsage({ orgId, tool, credentialName: input.credential, executionContext, ok: false, error: gate.error, latencyMs });
      return { ok: false, error: gate.error, latencyMs };
    }

    try {
      const rows = await gate.client.begin(async (tx) => {
        await setLocalStatementTimeout(tx, input.timeoutMs);
        return tx.unsafe(input.sql, input.params ?? []);
      });
      const shaped = shapeRows(rows, input.maxRows ?? MAX_ROWS_DEFAULT);
      const latencyMs = Date.now() - start;
      await fireUsage({ orgId, tool, credentialName: input.credential, executionContext, ok: true, latencyMs });
      return { ok: true, ...shaped, latencyMs };
    } catch (err) {
      const error = safeRuntimeError(err);
      const latencyMs = Date.now() - start;
      await fireUsage({ orgId, tool, credentialName: input.credential, executionContext, ok: false, error, latencyMs });
      return { ok: false, error, latencyMs };
    }
  },
};

export const dbQueryTransactionTool = {
  name: "db.query.transaction" as const,
  description: "Run a bounded transaction of parameterized Postgres SELECT/DML statements through a stored credential.",
  inputSchema: dbQueryTransactionInput,
  outputSchema: dbQueryTransactionOutput,
  inputExample: {
    credential: "customer-postgres",
    statements: [
      { sql: "update customers set status = $1 where id = $2", params: ["active", "cus_123"] },
      { sql: "select id, status from customers where id = $1", params: ["cus_123"] },
    ],
  },
  writeSide: true as const,
  async execute(
    input: z.infer<typeof dbQueryTransactionInput>,
    _context: Record<string, unknown>,
    executionContext: ToolExecutionContext,
  ): Promise<z.infer<typeof dbQueryTransactionOutput>> {
    const start = Date.now();
    const tool = "db.query.transaction" as const;
    const orgId = executionContext.orgId;
    const rateLimitPerMin = executionContext.integrations?.db?.rateLimitPerMin
      ?? envPositiveInt("JANUSLY_DB_TOOL_RATE_LIMIT_PER_MIN", DEFAULT_DB_RATE_LIMIT_PER_MIN);

    for (const statement of input.statements) {
      const validation = validateSql(statement.sql, statement.params ?? [], "any");
      if (!validation.ok) {
        const latencyMs = Date.now() - start;
        await fireUsage({ orgId, tool, credentialName: input.credential, executionContext, ok: false, error: validation.error, latencyMs });
        return { ok: false, error: validation.error, latencyMs };
      }
    }

    const gate = await gateDbCall({ orgId, credentialName: input.credential, tool, rateLimitPerMin });
    if (!gate.ok) {
      const latencyMs = Date.now() - start;
      await fireUsage({ orgId, tool, credentialName: input.credential, executionContext, ok: false, error: gate.error, latencyMs });
      return { ok: false, error: gate.error, latencyMs };
    }

    try {
      const maxRows = input.maxRowsPerStatement ?? MAX_ROWS_DEFAULT;
      const results = await gate.client.begin(async (tx) => {
        await setLocalStatementTimeout(tx, input.timeoutMs);
        const out: Array<{ rows?: Array<Record<string, unknown>>; rowCount: number; truncated?: boolean }> = [];
        for (const statement of input.statements) {
          const verb = firstSqlVerb(statement.sql);
          const sql = verb === "select" ? wrapReadSql(statement.sql, maxRows) : statement.sql;
          const rows = await tx.unsafe(sql, statement.params ?? []);
          out.push(shapeRows(rows, maxRows));
        }
        return out;
      });
      const latencyMs = Date.now() - start;
      await fireUsage({ orgId, tool, credentialName: input.credential, executionContext, ok: true, latencyMs });
      return { ok: true, results, latencyMs };
    } catch (err) {
      const error = safeRuntimeError(err);
      const latencyMs = Date.now() - start;
      await fireUsage({ orgId, tool, credentialName: input.credential, executionContext, ok: false, error, latencyMs });
      return { ok: false, error, latencyMs };
    }
  },
};

function validateDescribeIdentifiers(schema: string | undefined, tables: string[] | undefined): string | null {
  if (schema && !SAFE_IDENTIFIER.test(schema)) return "schema must be a simple Postgres identifier";
  for (const table of tables ?? []) {
    if (!SAFE_IDENTIFIER.test(table)) return "table names must be simple Postgres identifiers";
  }
  return null;
}

function buildSchemaDescribeQuery(schema: string | undefined, tables: string[] | undefined): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const clauses = ["table_schema not in ('pg_catalog', 'information_schema')"];
  if (schema) {
    params.push(schema);
    clauses.push(`table_schema = $${params.length}`);
  }
  if (tables && tables.length > 0) {
    params.push(tables);
    clauses.push(`table_name = any($${params.length}::text[])`);
  }
  const sql = `
    select table_schema, table_name, column_name, data_type, is_nullable, ordinal_position
    from information_schema.columns
    where ${clauses.join(" and ")}
    order by table_schema, table_name, ordinal_position
    limit ${SCHEMA_DESCRIBE_ROW_LIMIT + 1}
  `;
  return { sql, params };
}

function shapeSchemaRows(rows: ExternalDbRows): Array<z.infer<typeof dbTableOutput>> {
  const byTable = new Map<string, z.infer<typeof dbTableOutput>>();
  for (const row of rows.slice(0, SCHEMA_DESCRIBE_ROW_LIMIT)) {
    const schema = String(row.table_schema ?? "");
    const name = String(row.table_name ?? "");
    const key = `${schema}\u0000${name}`;
    const table = byTable.get(key) ?? { schema, name, columns: [] };
    table.columns.push({
      name: String(row.column_name ?? ""),
      type: String(row.data_type ?? "unknown"),
      nullable: row.is_nullable === "YES" || row.is_nullable === true,
      ordinalPosition: Number(row.ordinal_position ?? table.columns.length + 1),
    });
    byTable.set(key, table);
  }
  return [...byTable.values()];
}

function validateSql(sql: string, params: unknown[], kind: StatementKind): { ok: true } | { ok: false; error: string } {
  const trimmed = sql.trim();
  if (!trimmed) return { ok: false, error: "sql is required" };
  if (trimmed.length > SQL_TEXT_MAX) return { ok: false, error: "sql is too large" };
  if (trimmed.includes(";")) return { ok: false, error: "sql must contain exactly one statement and no semicolon" };
  if (SQL_COMMENT_PATTERN.test(trimmed)) return { ok: false, error: "sql comments are not allowed" };
  if (DANGEROUS_SQL_WORD_PATTERN.test(trimmed)) return { ok: false, error: "sql verb is not allowed" };

  const verb = firstSqlVerb(trimmed);
  if (kind === "read" && verb !== "select") {
    return { ok: false, error: "db.query.read only accepts SELECT statements" };
  }
  if (kind === "write" && !isWriteVerb(verb)) {
    return { ok: false, error: "db.query.write only accepts INSERT, UPDATE, or DELETE statements" };
  }
  if (kind === "any" && verb !== "select" && !isWriteVerb(verb)) {
    return { ok: false, error: "transactions accept only SELECT, INSERT, UPDATE, or DELETE statements" };
  }

  return validatePlaceholders(trimmed, params);
}

function firstSqlVerb(sql: string): string {
  return sql.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

function isWriteVerb(verb: string): boolean {
  return verb === "insert" || verb === "update" || verb === "delete";
}

function validatePlaceholders(sql: string, params: unknown[]): { ok: true } | { ok: false; error: string } {
  const seen = new Set<number>();
  for (const match of sql.matchAll(/\$(\d+)/g)) {
    const n = Number(match[1]);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "sql placeholders must start at $1" };
    seen.add(n);
  }
  const max = seen.size > 0 ? Math.max(...seen) : 0;
  for (let i = 1; i <= max; i += 1) {
    if (!seen.has(i)) return { ok: false, error: "sql placeholders must be contiguous from $1" };
  }
  if (params.length !== max) {
    return { ok: false, error: `params length (${params.length}) must match highest placeholder ($${max})` };
  }
  return { ok: true };
}

function wrapReadSql(sql: string, maxRows: number): string {
  return `select * from (${sql}) as janusly_db_query limit ${maxRows + 1}`;
}

async function setLocalStatementTimeout(client: ExternalDbRunner, timeoutMs: number | undefined): Promise<void> {
  const ms = Math.min(timeoutMs ?? DB_QUERY_TIMEOUT_MS_DEFAULT, DB_QUERY_TIMEOUT_MS_MAX);
  await client.unsafe(`set local statement_timeout = ${ms}`);
}

function shapeRows(rows: ExternalDbRows, maxRows: number): { rows: Array<Record<string, unknown>>; rowCount: number; truncated: boolean } {
  const allRows = Array.from(rows, rowToJsonSafeRecord);
  const truncated = allRows.length > maxRows;
  return {
    rows: allRows.slice(0, maxRows),
    rowCount: typeof rows.count === "number" ? rows.count : allRows.length,
    truncated,
  };
}

function rowToJsonSafeRecord(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = jsonSafe(value);
  return out;
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) out[key] = jsonSafe(nested);
    return out;
  }
  return value;
}

function safeRuntimeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err || "database query failed");
  const withoutUrls = raw.replace(/postgres(?:ql)?:\/\/\S+/gi, "[REDACTED_POSTGRES_URL]");
  const scrubbed = scrubSecretShapes(withoutUrls);
  const trimmed = scrubbed.trim();
  if (!trimmed) return "database query failed";
  return truncate(trimmed, 300);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function envPositiveInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
