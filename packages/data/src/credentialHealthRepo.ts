/**
 * Credential + MCP-connection health snapshot for the Operations UI
 * and the workflow readiness sidecar.
 *
 * The runtime resolves a credential's ``secret_ref`` to a real env var
 * at execute time. When the env var is missing or empty, the run fails
 * mid-flight with the generic ``credential secret missing for <name>``
 * envelope — the operator only learns about it AFTER a real workflow
 * has tripped over it. This module produces a per-org snapshot so the
 * UI + readiness gate can surface broken credentials BEFORE a run
 * starts.
 *
 * Used by:
 * - ``apps/api/src/routes/credentials-routes.ts`` (``GET /credentials/health``).
 * - ``apps/api/src/readiness-helpers.ts`` (the ``credential_missing``
 *   warn rule's sidecar).
 *
 * Invariants:
 * - **Env-var-name leakage is the load-bearing security property.**
 *   The returned shape NEVER carries ``credentials.secret_ref``,
 *   ``McpEnvRef.name``, or any other env-var name. Only operator-
 *   visible identifiers (credential ``name``, MCP ``alias``, the
 *   operator-chosen KEY of an ``envRefs`` map) are returned.
 * - Multi-tenant scope: every query filters by ``orgId``. There is no
 *   helper that bypasses the filter.
 * - The data layer does NOT freely touch ``process.env``. The single
 *   chokepoint is the ``SecretRefResolver`` callback the caller
 *   injects. Tests pass a fake; production wires a thin reader.
 * - ``lastErrorMessage`` is scrubbed via ``scrubSecretShapes`` at read
 *   time. Defense-in-depth on top of ``safePersistPayload`` at the
 *   ``usage_events.metadata`` write site.
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  credentials,
  db,
  mcpConnections,
  mcpToolDescriptors,
  usageEvents,
  workflowVersions,
} from "@janusly/db";
import { scrubSecretShapes } from "@janusly/shared/src/error-signature";
import {
  listConnections,
  listToolDescriptors,
  type McpConnectionRow,
  type McpConnectionStatus,
} from "./mcpConnectionsRepo";

/**
 * Boolean callback that reports whether the env var named ``envVarName``
 * resolves to a non-empty value in the current process. The data layer
 * NEVER reads ``process.env`` directly; the caller is the single chokepoint
 * for that side effect.
 */
export type SecretRefResolver = (envVarName: string) => boolean;

export type CredentialHealthEntry = {
  id: string;
  name: string;
  kind: string;
  /** ``true`` when the resolver reports the env var has a non-empty value.
   *  The env-var NAME is never returned alongside this flag. */
  secretRefPresent: boolean;
  /** ISO timestamp of the latest successful ``usage_events`` row for this
   *  credential, or ``null`` when no row has been written. */
  lastUsedAt: string | null;
  /** ISO timestamp of the latest failing ``usage_events`` row. */
  lastErrorAt: string | null;
  /** Latest failure message, passed through ``scrubSecretShapes``. */
  lastErrorMessage: string | null;
  /** Count of ``usage_events`` rows tagged with this credential in the
   *  last 30 days. */
  usageCount30d: number;
  /** Workflow ids that reference this credential in their LATEST persisted
   *  version. Older versions that no longer reference it are excluded. */
  referencingWorkflowIds: string[];
};

export type McpConnectionHealthEntry = {
  alias: string;
  status: McpConnectionStatus;
  statusReason: string | null;
  lastDiscoveryAt: string | null;
  /** Whole days since the connection was last discovered. ``null`` when
   *  discovery has never run. Operators paint amber when this exceeds the
   *  staleness threshold. */
  staleDays: number | null;
  toolCount: number;
  enabledToolCount: number;
  lastUsedAt: string | null;
  /** Operator-chosen KEYS from ``mcp_connections.env_refs`` whose mapped
   *  env vars are missing or empty. The mapped env-var NAMES are NEVER
   *  returned. */
  envRefsMissingKeys: string[];
  /** Workflow ids that reference this MCP connection (by alias) in their
   *  LATEST persisted version. Symmetric with
   *  ``CredentialHealthEntry.referencingWorkflowIds``. */
  referencingWorkflowIds: string[];
};

export type CredentialHealth = {
  credentials: CredentialHealthEntry[];
  mcpConnections: McpConnectionHealthEntry[];
  generatedAt: string;
};

/** Defensive cap on the number of workflow versions scanned for the
 *  "which workflows reference credential X" reverse index. v1 operator-tier
 *  reads bounded by this cap; the few orgs near the ceiling can extend
 *  later. */
const WORKFLOW_VERSION_SCAN_CAP = 500;

/** Lookback for ``usageCount30d`` / latest-usage joins. */
const USAGE_LOOKBACK_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function staleDaysFrom(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const ts = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(ts)) return null;
  return Math.max(0, Math.floor((Date.now() - ts) / MS_PER_DAY));
}

/** Reverse indexes: credential name / MCP alias → set of workflow ids that
 *  reference them in their latest persisted DAG. Both surfaces ride on
 *  the same single-pass scan so the snapshot can answer "who would
 *  break if this is broken" symmetrically for credentials and MCP
 *  connections. */
export type WorkflowReferenceIndex = {
  byCredentialName: Map<string, Set<string>>;
  byMcpAlias: Map<string, Set<string>>;
};

/** Extract the operator-chosen credential name from a node config.
 *  Integration-tool nodes store it under ``input.credential``; the
 *  top-level ``credential`` path is kept for older fixtures / callers. */
export function readCredentialNameFromConfig(config: unknown): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const record = config as Record<string, unknown>;
  const direct = record.credential;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const input = record.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const nested = (input as { credential?: unknown }).credential;
  return typeof nested === "string" && nested.length > 0 ? nested : null;
}

/** Walk a workflow DAG's nodes once and collect credential + MCP-alias
 *  references. Pure helper, exported for tests. */
export function collectWorkflowReferences(
  workflowId: string,
  dagJson: unknown,
  index: WorkflowReferenceIndex,
): void {
  if (!dagJson || typeof dagJson !== "object") return;
  const nodes = (dagJson as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const config = (node as { config?: unknown }).config;
    if (!config || typeof config !== "object") continue;
    const credential = readCredentialNameFromConfig(config);
    if (credential) {
      let set = index.byCredentialName.get(credential);
      if (!set) {
        set = new Set();
        index.byCredentialName.set(credential, set);
      }
      set.add(workflowId);
    }
    const alias = (config as { connectionAlias?: unknown }).connectionAlias;
    if (typeof alias === "string" && alias.length > 0) {
      let set = index.byMcpAlias.get(alias);
      if (!set) {
        set = new Set();
        index.byMcpAlias.set(alias, set);
      }
      set.add(workflowId);
    }
  }
}

type LatestWorkflowVersion = { workflowId: string; dagJson: unknown };

/** Fetch the latest persisted workflow version per workflow id for an
 *  org, capped at ``WORKFLOW_VERSION_SCAN_CAP``. The cap is applied AFTER
 *  the latest-per-workflow filter so an org with thousands of historical
 *  versions doesn't blow the budget. */
async function loadLatestWorkflowVersions(orgId: string): Promise<LatestWorkflowVersion[]> {
  // Two-step approach so older Postgres / Drizzle combinations don't
  // need ``DISTINCT ON``. Step 1: per-workflow ``max(version)`` in one
  // round-trip. Step 2: fetch each matching ``dag_json`` row IN
  // PARALLEL via ``Promise.all`` — N+1 round-trips remain but at
  // network-latency-bound cost (~1× p95 not ~N× p95). Both queries
  // are tenant-scoped on ``orgId``.
  const maxVersions = await db
    .select({
      workflowId: workflowVersions.workflowId,
      maxVersion: sql<number>`max(${workflowVersions.version})`.as("max_version"),
    })
    .from(workflowVersions)
    .where(eq(workflowVersions.orgId, orgId))
    .groupBy(workflowVersions.workflowId)
    .limit(WORKFLOW_VERSION_SCAN_CAP);
  if (maxVersions.length === 0) return [];

  const settled = await Promise.all(
    maxVersions.map((row) =>
      db
        .select({
          workflowId: workflowVersions.workflowId,
          dagJson: workflowVersions.dagJson,
        })
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.orgId, orgId),
            eq(workflowVersions.workflowId, row.workflowId),
            eq(workflowVersions.version, row.maxVersion),
          ),
        )
        .limit(1)
        .then((matches) => matches[0] ?? null),
    ),
  );
  const out: LatestWorkflowVersion[] = [];
  for (const hit of settled) {
    if (hit) out.push({ workflowId: hit.workflowId, dagJson: hit.dagJson });
  }
  return out;
}

/** One workflow that references a credential by name, plus the specific node
 *  ids carrying the reference. Powers the rotation route's blast-radius
 *  preview so an operator sees exactly what a rotation touches. */
export type CredentialWorkflowReference = {
  workflowId: string;
  workflowName: string;
  nodeIds: string[];
};

/**
 * Resolve every latest-version workflow that references `credentialName`,
 * with the matching node ids + the workflow's display name. Reuses the same
 * `loadLatestWorkflowVersions` + `readCredentialNameFromConfig` machinery the
 * health snapshot uses, so the rotation preview and the credential-health
 * card agree on "who uses this credential". Org-scoped via the version load;
 * pure read, no mutation.
 */
export async function resolveCredentialReferences(
  orgId: string,
  credentialName: string,
): Promise<CredentialWorkflowReference[]> {
  const versions = await loadLatestWorkflowVersions(orgId);
  const out: CredentialWorkflowReference[] = [];
  for (const { workflowId, dagJson } of versions) {
    if (!dagJson || typeof dagJson !== "object") continue;
    const dag = dagJson as { name?: unknown; nodes?: unknown };
    const nodes = Array.isArray(dag.nodes) ? dag.nodes : [];
    const nodeIds: string[] = [];
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      if (readCredentialNameFromConfig((node as { config?: unknown }).config) === credentialName) {
        const id = (node as { id?: unknown }).id;
        if (typeof id === "string") nodeIds.push(id);
      }
    }
    if (nodeIds.length > 0) {
      out.push({
        workflowId,
        workflowName: typeof dag.name === "string" && dag.name.length > 0 ? dag.name : workflowId,
        nodeIds,
      });
    }
  }
  return out;
}

type CredentialUsageAggregate = {
  lastUsedAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  usageCount30d: number;
};

/** Build a per-credential-name aggregate over the last
 *  ``USAGE_LOOKBACK_DAYS`` days of ``usage_events`` rows tagged with
 *  ``metadata.credentialName``. The ``metadata ? 'credentialName'`` guard
 *  filters rows from before the field was introduced. */
async function loadCredentialUsageAggregates(
  orgId: string,
): Promise<Map<string, CredentialUsageAggregate>> {
  const since = new Date(Date.now() - USAGE_LOOKBACK_DAYS * MS_PER_DAY);
  const rows = await db
    .select({
      name: sql<string>`${usageEvents.metadata} ->> 'credentialName'`.as("cred_name"),
      createdAt: usageEvents.createdAt,
      ok: sql<boolean | null>`(${usageEvents.metadata} ->> 'ok')::bool`.as("ok"),
      error: sql<string | null>`${usageEvents.metadata} ->> 'error'`.as("error_msg"),
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.orgId, orgId),
        gte(usageEvents.createdAt, since),
        sql`${usageEvents.metric} like 'tool.%'`,
        sql`${usageEvents.metadata} ? 'credentialName'`,
      ),
    )
    .orderBy(desc(usageEvents.createdAt));

  const map = new Map<string, CredentialUsageAggregate>();
  for (const row of rows) {
    if (!row.name) continue;
    const entry =
      map.get(row.name) ??
      ({
        lastUsedAt: null,
        lastErrorAt: null,
        lastErrorMessage: null,
        usageCount30d: 0,
      } satisfies CredentialUsageAggregate);
    entry.usageCount30d += 1;
    const iso = toIso(row.createdAt);
    if (row.ok === true) {
      if (!entry.lastUsedAt) entry.lastUsedAt = iso;
    } else if (row.ok === false) {
      if (!entry.lastErrorAt) {
        entry.lastErrorAt = iso;
        entry.lastErrorMessage = row.error ? scrubSecretShapes(row.error) : null;
      }
    } else {
      // Legacy rows missing `metadata.ok`: treat as a successful use.
      if (!entry.lastUsedAt) entry.lastUsedAt = iso;
    }
    map.set(row.name, entry);
  }
  return map;
}

type McpUsageAggregate = {
  lastUsedAt: string | null;
};

async function loadMcpUsageAggregates(orgId: string): Promise<Map<string, McpUsageAggregate>> {
  const since = new Date(Date.now() - USAGE_LOOKBACK_DAYS * MS_PER_DAY);
  const rows = await db
    .select({
      alias: sql<string>`${usageEvents.metadata} ->> 'connectionAlias'`.as("conn_alias"),
      createdAt: usageEvents.createdAt,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.orgId, orgId),
        gte(usageEvents.createdAt, since),
        sql`${usageEvents.metric} like 'tool.mcp.%'`,
        sql`${usageEvents.metadata} ? 'connectionAlias'`,
      ),
    )
    .orderBy(desc(usageEvents.createdAt));
  const map = new Map<string, McpUsageAggregate>();
  for (const row of rows) {
    if (!row.alias) continue;
    if (!map.has(row.alias)) {
      map.set(row.alias, { lastUsedAt: toIso(row.createdAt) });
    }
  }
  return map;
}

async function buildMcpHealthEntries(
  orgId: string,
  resolver: SecretRefResolver,
  usage: Map<string, McpUsageAggregate>,
  workflowsByAlias: Map<string, Set<string>>,
): Promise<McpConnectionHealthEntry[]> {
  const connections: McpConnectionRow[] = await listConnections(orgId);
  const out: McpConnectionHealthEntry[] = [];
  for (const conn of connections) {
    const descriptors = await listToolDescriptors(conn.id);
    const enabledToolCount = descriptors.reduce((n, d) => n + (d.enabled ? 1 : 0), 0);
    const envRefsMissingKeys: string[] = [];
    for (const [key, ref] of Object.entries(conn.envRefs)) {
      if (!resolver(ref.name)) envRefsMissingKeys.push(key);
    }
    out.push({
      alias: conn.alias,
      status: conn.status,
      statusReason: conn.statusReason,
      lastDiscoveryAt: toIso(conn.lastDiscoveryAt),
      staleDays: staleDaysFrom(conn.lastDiscoveryAt),
      toolCount: descriptors.length,
      enabledToolCount,
      lastUsedAt: usage.get(conn.alias)?.lastUsedAt ?? null,
      envRefsMissingKeys,
      referencingWorkflowIds: Array.from(workflowsByAlias.get(conn.alias) ?? []).sort(),
    });
  }
  return out;
}

/**
 * Per-org credential + MCP-connection health snapshot. Three bulk
 * queries (credentials, usage aggregate, latest workflow versions) plus
 * one round-trip per MCP connection (mirrors the existing
 * ``GET /mcp/connections`` enrichment pattern). The function never throws
 * on transient failures of one branch — partial results would be a
 * regression on the load-bearing "operators see this before a run
 * fails" promise. Errors bubble so the route handler can surface them.
 */
export async function getCredentialHealth(
  orgId: string,
  resolver: SecretRefResolver,
): Promise<CredentialHealth> {
  const [credRows, usage, mcpUsage, latestVersions] = await Promise.all([
    db.select().from(credentials).where(eq(credentials.orgId, orgId)),
    loadCredentialUsageAggregates(orgId),
    loadMcpUsageAggregates(orgId),
    loadLatestWorkflowVersions(orgId),
  ]);

  const referenceIndex: WorkflowReferenceIndex = {
    byCredentialName: new Map(),
    byMcpAlias: new Map(),
  };
  for (const v of latestVersions) {
    collectWorkflowReferences(v.workflowId, v.dagJson, referenceIndex);
  }

  const credentialEntries: CredentialHealthEntry[] = credRows.map((row) => {
    const aggregate = usage.get(row.name);
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      secretRefPresent: resolver(row.secretRef),
      lastUsedAt: aggregate?.lastUsedAt ?? null,
      lastErrorAt: aggregate?.lastErrorAt ?? null,
      lastErrorMessage: aggregate?.lastErrorMessage ?? null,
      usageCount30d: aggregate?.usageCount30d ?? 0,
      referencingWorkflowIds: Array.from(referenceIndex.byCredentialName.get(row.name) ?? []).sort(),
    };
  });

  const mcpConnectionEntries = await buildMcpHealthEntries(
    orgId,
    resolver,
    mcpUsage,
    referenceIndex.byMcpAlias,
  );

  return {
    credentials: credentialEntries,
    mcpConnections: mcpConnectionEntries,
    generatedAt: new Date().toISOString(),
  };
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "Decision engine / RL".
