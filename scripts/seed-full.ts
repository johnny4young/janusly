/**
 * Full demo seeder — populates EVERY table with a rich, coherent dataset so
 * every screen of the app has plenty of data: many users / members, many
 * workflows + versions + runs, DLQ + recovery incidents, alert policies +
 * dispatches, a fully-configured org-config catalog, credentials, MCP
 * connections, prompts, memory, usage + audit history, SCIM directory, SSO,
 * auto-healing, and more.
 *
 * Usage:
 *   pnpm seed:full                 # reset + reseed org "default"
 *   pnpm seed:full -- --org=acme   # target a different org
 *
 * Run while the dev DB is up (`pnpm dev` or Compose alone). It RESETS the
 * target org first (deletes the org's rows in every table it populates) and
 * then reinserts a fresh dataset, so re-running gives a clean, predictable
 * slate. Refuses to run with JANUSLY_PRODUCTION_MODE=true.
 */

import { eq, inArray } from "drizzle-orm";
import {
  db,
  client,
  organizations,
  users,
  orgMembers,
  orgConfigs,
  orgRoles,
  invitations,
  verifiedDomains,
  ssoConnections,
  ssoStateNonces,
  scimDirectories,
  scimUserState,
  scimGroupState,
  scimProcessedEvents,
  workflows,
  workflowVersions,
  workflowMetadata,
  workflowBudgets,
  scheduleEntries,
  runs,
  runNodes,
  runEvents,
  deadLetters,
  recoveryItems,
  recoveryItemChildren,
  recoveryItemHandoffs,
  recoveryFeedback,
  routingStats,
  workflowImprovements,
  autoHealingRuns,
  alertPolicies,
  alertDispatches,
  usageEvents,
  auditLogs,
  credentials,
  installedPlugins,
  mcpConnections,
  mcpToolDescriptors,
  prompts,
  promptVersions,
  memoryEntries,
} from "@janusly/db";

// ----------------------------------------------------------------------------
// config + helpers
// ----------------------------------------------------------------------------

function parseOrgId(): string {
  const arg = process.argv.find((a) => a.startsWith("--org="));
  return arg ? arg.slice("--org=".length) : "default";
}

const ORG = parseOrgId();
const NOW = Date.now();

function assertNotProduction(): void {
  if (process.env.JANUSLY_PRODUCTION_MODE === "true") {
    console.error("[seed-full] refusing to run with JANUSLY_PRODUCTION_MODE=true — dev-only seeder.");
    process.exit(1);
  }
}

let _seq = 0;
const uid = (p: string) => `seed_${p}_${(++_seq).toString(36).padStart(4, "0")}`;

function daysAgo(n: number): Date {
  return new Date(NOW - n * 86_400_000);
}
function hoursAgo(n: number): Date {
  return new Date(NOW - n * 3_600_000);
}
function minutesAgo(n: number): Date {
  return new Date(NOW - n * 60_000);
}
function daysFromNow(n: number): Date {
  return new Date(NOW + n * 86_400_000);
}

// deterministic-ish PRNG so re-runs produce a similar shape
let _rngState = 1337;
function rng(): number {
  _rngState = (_rngState * 9301 + 49297) % 233280;
  return _rngState / 233280;
}
const randInt = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1));
const sample = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;
const chance = (p: number) => rng() < p;
const round2 = (n: number) => Math.round(n * 100) / 100;

function fakeEmbedding(seed: number): number[] {
  const out: number[] = [];
  let x = (seed * 2654435761) % 2147483647;
  for (let i = 0; i < 1024; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(Number(((x / 2147483648) * 2 - 1).toFixed(4)));
  }
  return out;
}

async function insertChunked<T>(table: any, rows: T[], chunk = 400): Promise<void> {
  for (let i = 0; i < rows.length; i += chunk) {
    await db.insert(table).values(rows.slice(i, i + chunk) as any);
  }
}

// ----------------------------------------------------------------------------
// base data pools
// ----------------------------------------------------------------------------

const FIRST = [
  "Ana", "Carlos", "Lucía", "Diego", "Sofía", "Mateo", "Valentina", "Sebastián",
  "Camila", "Andrés", "Isabella", "Daniel", "Mariana", "Felipe", "Gabriela",
  "Tomás", "Renata", "Julián", "Paula", "Nicolás", "Antonella", "Emilio",
  "Catalina", "Maximiliano", "Regina", "Joaquín", "Victoria", "Samuel",
  "Fernanda", "Bruno", "Elena", "Adrián", "Olivia", "Martín", "Daniela",
  "Leonardo", "Carolina", "Rodrigo", "Natalia", "Esteban", "Jimena", "Ignacio",
  "Salomé", "Alejandro", "Manuela", "Cristóbal", "Verónica", "Patricio",
];
const LAST = [
  "García", "Rodríguez", "Martínez", "López", "González", "Pérez", "Sánchez",
  "Ramírez", "Torres", "Flores", "Rivera", "Gómez", "Díaz", "Cruz", "Morales",
  "Ortiz", "Gutiérrez", "Chávez", "Ramos", "Vargas", "Castillo", "Jiménez",
  "Romero", "Herrera", "Medina", "Aguilar", "Vega", "Reyes", "Mendoza", "Rojas",
];
const DOMAINS = ["acme.com", "globex.io", "initech.dev", "umbrella.co", "hooli.com"];
const ROLES = ["viewer", "editor", "admin"] as const;

// ----------------------------------------------------------------------------
// reset
// ----------------------------------------------------------------------------

async function reset(): Promise<void> {
  console.log(`[seed-full] resetting org="${ORG}" …`);
  // child rows without org_id — scope by parent
  await db.delete(runNodes).where(inArray(runNodes.runId, db.select({ id: runs.id }).from(runs).where(eq(runs.orgId, ORG))));
  await db.delete(runEvents).where(inArray(runEvents.runId, db.select({ id: runs.id }).from(runs).where(eq(runs.orgId, ORG))));
  await db.delete(mcpToolDescriptors).where(inArray(mcpToolDescriptors.connectionId, db.select({ id: mcpConnections.id }).from(mcpConnections).where(eq(mcpConnections.orgId, ORG))));

  const byOrg = [
    recoveryItemChildren, recoveryItemHandoffs, recoveryItems, recoveryFeedback,
    deadLetters, autoHealingRuns, alertDispatches, alertPolicies,
    runs, scheduleEntries, workflowVersions, workflowMetadata, workflowBudgets,
    workflowImprovements, routingStats, workflows,
    usageEvents, auditLogs, credentials, installedPlugins,
    mcpConnections, promptVersions, prompts, memoryEntries,
    orgConfigs, orgRoles, invitations, verifiedDomains,
    ssoConnections, ssoStateNonces,
    scimProcessedEvents, scimUserState, scimGroupState, scimDirectories,
    orgMembers, users,
  ];
  for (const table of byOrg) {
    await db.delete(table as any).where(eq((table as any).orgId, ORG));
  }
  await db.delete(organizations).where(eq(organizations.id, ORG));
}

// ----------------------------------------------------------------------------
// seed
// ----------------------------------------------------------------------------

async function seed(): Promise<void> {
  assertNotProduction();
  await reset();

  // --- organization -------------------------------------------------------
  await db.insert(organizations).values({
    id: ORG,
    name: ORG === "default" ? "Janusly Demo Co." : `${ORG} Co.`,
    plan: "scale",
    stripeCustomerId: "cus_demo_janusly",
    stripeSubscriptionId: "sub_demo_janusly",
    createdAt: daysAgo(180),
  });

  // --- users + members ----------------------------------------------------
  type Member = { userId: string; email: string; name: string; role: string };
  const members: Member[] = [];

  // current dev operator — explicit admin so the dev session keeps admin rights
  members.push({ userId: "dev-user", email: "operator@janusly.dev", name: "Dev Operator", role: "admin" });

  const usedEmails = new Set<string>(["operator@janusly.dev"]);
  const TOTAL_MEMBERS = 46;
  for (let i = 0; i < TOTAL_MEMBERS; i++) {
    const first = FIRST[i % FIRST.length]!;
    const last = LAST[(i * 7) % LAST.length]!;
    const name = `${first} ${last}`;
    const dom = DOMAINS[i % DOMAINS.length]!;
    let email = `${first}.${last}@${dom}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    while (usedEmails.has(email)) email = `${first}.${last}.${i}@${dom}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    usedEmails.add(email);
    // weighted roles: lots of viewers, some editors, few admins + a couple custom
    const r = rng();
    const role = r < 0.55 ? "viewer" : r < 0.85 ? "editor" : r < 0.94 ? "admin" : sample(["compliance", "ops-readonly", "billing-admin"]);
    members.push({ userId: uid("usr"), email, name, role });
  }

  await insertChunked(users, members.map((m, i) => ({
    id: m.userId,
    orgId: ORG,
    email: m.email,
    name: m.name,
    createdAt: daysAgo(170 - Math.min(i * 3, 160)),
  })));

  await insertChunked(orgMembers, members.map((m, i) => ({
    id: uid("mem"),
    orgId: ORG,
    userId: m.userId,
    email: m.email,
    role: m.role,
    invitedBy: i === 0 ? null : "dev-user",
    createdAt: daysAgo(168 - Math.min(i * 3, 158)),
  })));
  console.log(`[seed-full] members: ${members.length}`);

  const adminIds = members.filter((m) => m.role === "admin").map((m) => m.userId);
  const someUser = () => sample(members).userId;

  // --- org roles (custom only) --------------------------------------------
  // NOTE: we intentionally do NOT override the built-in viewer/editor/admin
  // roles. A non-null `grantedPermissions` on a built-in REPLACES the catalog
  // defaults entirely (see schema.ts org_roles docs), so overriding admin with
  // a partial list would silently strip permissions like `members.read` and
  // lock the dev admin out of permission-gated routes. Built-ins stay virtual
  // (full catalog defaults); only custom roles get rows.
  await insertChunked(orgRoles, [
    { id: uid("role"), orgId: ORG, name: "compliance", inheritsFrom: "viewer", description: "Read-only auditor with credential visibility", isBuiltin: false, grantedPermissions: ["workflows.read", "runs.read", "recovery.read", "credentials.read", "alerts.read"], createdBy: "dev-user", createdAt: daysAgo(90), updatedAt: daysAgo(90) },
    { id: uid("role"), orgId: ORG, name: "ops-readonly", inheritsFrom: "viewer", description: "On-call read access to runs + recovery", isBuiltin: false, grantedPermissions: ["workflows.read", "runs.read", "recovery.read", "autohealing.read", "alerts.read"], createdBy: "dev-user", createdAt: daysAgo(75), updatedAt: daysAgo(75) },
    { id: uid("role"), orgId: ORG, name: "billing-admin", inheritsFrom: "admin", description: "Budget + config admin, no member management", isBuiltin: false, grantedPermissions: ["org.config.write", "workflows.read", "runs.read", "recovery.read"], createdBy: "dev-user", createdAt: daysAgo(60), updatedAt: daysAgo(60) },
  ]);

  // --- org configs (rich, mostly non-default) -----------------------------
  type Cfg = { key: string; category: string; valueType: "string" | "number" | "boolean"; value: unknown };
  const CONFIGS: Cfg[] = [
    { key: "ai.provider", category: "ai", valueType: "string", value: "anthropic" },
    { key: "ai.anthropic.model", category: "ai", valueType: "string", value: "claude-haiku-4-5-20251001" },
    { key: "ai.openai.model", category: "ai", valueType: "string", value: "gpt-4o-mini" },
    { key: "ai.timeoutMs", category: "ai", valueType: "number", value: 45000 },
    { key: "ai.maxRetries", category: "ai", valueType: "number", value: 3 },
    { key: "ai.promptMaxChars", category: "ai", valueType: "number", value: 8000 },
    { key: "ai.rateLimitPerMin", category: "ai", valueType: "number", value: 60 },
    { key: "ai.budgetMonthlyUsd", category: "ai", valueType: "number", value: 500 },
    { key: "ai.budgetWarnPercent", category: "ai", valueType: "number", value: 75 },
    { key: "ai.budgetExceededPolicy", category: "ai", valueType: "string", value: "warn" },
    { key: "http.timeoutMs", category: "http", valueType: "number", value: 30000 },
    { key: "http.maxResponseBytes", category: "http", valueType: "number", value: 2000000 },
    { key: "http.maxRedirects", category: "http", valueType: "number", value: 5 },
    { key: "http.streamPreviewBytes", category: "http", valueType: "number", value: 131072 },
    { key: "email.provider", category: "email", valueType: "string", value: "resend" },
    { key: "email.from", category: "email", valueType: "string", value: "ops@janusly.dev" },
    { key: "email.rateLimitPerMin", category: "email", valueType: "number", value: 120 },
    { key: "runs.requireSavedWorkflow", category: "runs", valueType: "boolean", value: true },
    { key: "subworkflow.maxDepth", category: "runs", valueType: "number", value: 6 },
    { key: "runs.streamMaxSubscriptions", category: "runs", valueType: "number", value: 100 },
    { key: "mcp.writeConsent", category: "mcp", valueType: "boolean", value: true },
    { key: "mcp.clientWriteConsent", category: "mcp", valueType: "boolean", value: true },
    { key: "mcp.clientRateLimitPerMin", category: "mcp", valueType: "number", value: 90 },
    { key: "mcp.clientCommandAllowlist", category: "mcp", valueType: "string", value: "npx,node,uvx" },
    { key: "mcp.stdioMaxLifetimeMs", category: "mcp", valueType: "number", value: 600000 },
    { key: "mcp.stdioMaxStderrBytes", category: "mcp", valueType: "number", value: 65536 },
    { key: "mcp.stdioMaxVmKb", category: "mcp", valueType: "number", value: 524288 },
    { key: "slack.rateLimitPerMin", category: "integrations", valueType: "number", value: 80 },
    { key: "github.rateLimitPerMin", category: "integrations", valueType: "number", value: 60 },
    { key: "webhook.rateLimitPerMin", category: "integrations", valueType: "number", value: 150 },
    { key: "pdf.rateLimitPerMin", category: "integrations", valueType: "number", value: 40 },
    { key: "objectstore.provider", category: "objectstore", valueType: "string", value: "s3" },
    { key: "auth.allowedEmailDomains", category: "auth", valueType: "string", value: "acme.com,globex.io,initech.dev" },
    { key: "auth.mfaRequired", category: "auth", valueType: "boolean", value: true },
    { key: "auth.sessionTtlSeconds", category: "auth", valueType: "number", value: 43200 },
    { key: "memory.enabled", category: "memory", valueType: "boolean", value: true },
    { key: "memory.allowedKinds", category: "memory", valueType: "string", value: "recovery_rationale,run_summary,runbook_fragment,patch_rationale" },
    { key: "memory.recallMaxEntries", category: "memory", valueType: "number", value: 12 },
    { key: "memory.recallMaxBytes", category: "memory", valueType: "number", value: 16384 },
    { key: "memory.embeddingProvider", category: "memory", valueType: "string", value: "ollama" },
    { key: "memory.embeddingModel", category: "memory", valueType: "string", value: "bge-m3" },
    { key: "autoHealing.enabled", category: "auto-healing", valueType: "boolean", value: true },
    { key: "autoHealing.autoApply", category: "auto-healing", valueType: "boolean", value: false },
    { key: "autoHealing.maxAttemptsPerSignature", category: "auto-healing", valueType: "number", value: 4 },
    { key: "autoHealing.loopWindowDays", category: "auto-healing", valueType: "number", value: 21 },
    { key: "recovery.autoCreateItems", category: "recovery", valueType: "boolean", value: true },
    { key: "recovery.debounceWindowSeconds", category: "recovery", valueType: "number", value: 300 },
    { key: "value.hourlyCost", category: "value", valueType: "number", value: 85 },
    { key: "value.minutesSavedPerRecovery", category: "value", valueType: "number", value: 35 },
    { key: "value.baselineMttrSeconds", category: "value", valueType: "number", value: 5400 },
  ];
  await insertChunked(orgConfigs, CONFIGS.map((c) => ({
    id: uid("cfg"),
    orgId: ORG,
    key: c.key,
    valueJson: c.value as any,
    category: c.category,
    description: `Tenant override for ${c.key}`,
    valueType: c.valueType,
    source: "tenant",
    createdBy: "dev-user",
    updatedBy: "dev-user",
    createdAt: daysAgo(100),
    updatedAt: daysAgo(randInt(1, 40)),
  })));
  console.log(`[seed-full] org_configs: ${CONFIGS.length}`);

  // --- invitations / verified domains / sso / scim ------------------------
  const inviteRows = [];
  for (let i = 0; i < 18; i++) {
    const first = sample(FIRST), last = sample(LAST), dom = sample(DOMAINS);
    const status = i < 10 ? "pending" : i < 15 ? "accepted" : "revoked";
    inviteRows.push({
      id: uid("inv"),
      orgId: ORG,
      email: `${first}.${last}.invite${i}@${dom}`.toLowerCase(),
      role: sample(ROLES),
      invitedBy: sample(adminIds),
      status,
      acceptedAt: status === "accepted" ? daysAgo(randInt(1, 30)) : null,
      createdAt: daysAgo(randInt(5, 60)),
    });
  }
  await insertChunked(invitations, inviteRows);

  await insertChunked(verifiedDomains, DOMAINS.slice(0, 4).map((d, i) => ({
    id: uid("vd"),
    orgId: ORG,
    domain: d,
    defaultRole: i === 0 ? "editor" : "viewer",
    createdAt: daysAgo(140 - i * 10),
  })));

  await insertChunked(ssoConnections, [
    { id: uid("sso"), orgId: ORG, provider: "workos", providerConnectionId: "conn_01JANUSLYDEMO0001", status: "active", enforcedSso: false, configJson: { domains: ["acme.com"], idp: "Okta" }, createdAt: daysAgo(120), updatedAt: daysAgo(20) },
    { id: uid("sso"), orgId: ORG, provider: "azure-ad", providerConnectionId: "conn_01JANUSLYDEMO0002", status: "revoked", enforcedSso: false, configJson: { domains: ["globex.io"], idp: "Azure AD" }, createdAt: daysAgo(95), updatedAt: daysAgo(50) },
  ]);

  await insertChunked(ssoStateNonces, [
    { id: uid("nonce"), orgId: ORG, nonce: uid("n"), expiresAt: daysFromNow(0.006), createdAt: minutesAgo(3) },
  ]);

  const scimDirId = uid("scimdir");
  await db.insert(scimDirectories).values({
    id: scimDirId, orgId: ORG, providerDirectoryId: "directory_01JANUSLYDEMO", directoryType: "okta scim v2.0",
    defaultRole: "viewer", status: "active", lastSyncedAt: hoursAgo(4), createdAt: daysAgo(110), updatedAt: hoursAgo(4),
  });
  const scimUsers = [];
  for (let i = 0; i < 24; i++) {
    const first = sample(FIRST), last = sample(LAST);
    scimUsers.push({
      id: uid("scimusr"), orgId: ORG, scimDirectoryId: scimDirId,
      providerUserId: `directory_user_${i.toString().padStart(4, "0")}`,
      email: `${first}.${last}.scim${i}@acme.com`.toLowerCase(),
      firstName: first, lastName: last, active: i % 9 !== 0,
      lastEventId: uid("evt"), lastEventTimestamp: daysAgo(randInt(1, 30)),
      createdAt: daysAgo(randInt(30, 100)), updatedAt: daysAgo(randInt(1, 29)),
    });
  }
  await insertChunked(scimUserState, scimUsers);
  await insertChunked(scimGroupState, ["Engineering", "Operations", "Finance", "Security", "Support", "Leadership"].map((g, i) => ({
    id: uid("scimgrp"), orgId: ORG, scimDirectoryId: scimDirId,
    providerGroupId: `directory_group_${i}`, name: g, lastSyncedAt: hoursAgo(randInt(2, 48)),
  })));
  const scimEventTypes = ["dsync.user.created", "dsync.user.updated", "dsync.user.deleted", "dsync.group.created", "dsync.group.user_added"];
  await insertChunked(scimProcessedEvents, Array.from({ length: 40 }, (_, i) => ({
    eventId: `event_${i.toString().padStart(6, "0")}_${ORG}`,
    orgId: ORG, scimDirectoryId: scimDirId, eventType: sample(scimEventTypes), processedAt: daysAgo(randInt(1, 60)),
  })));
  console.log(`[seed-full] scim users: ${scimUsers.length}`);

  // --- credentials --------------------------------------------------------
  const CREDS = [
    { name: "incidents-slack", kind: "slack_webhook", secretRef: "SLACK_INCIDENTS_WEBHOOK_URL" },
    { name: "alerts-slack", kind: "slack_webhook", secretRef: "SLACK_ALERTS_WEBHOOK_URL" },
    { name: "bot-github", kind: "github_token", secretRef: "GITHUB_BOT_TOKEN" },
    { name: "release-github", kind: "github_token", secretRef: "GITHUB_RELEASE_TOKEN" },
    { name: "partner-webhook", kind: "webhook_secret", secretRef: "WEBHOOK_SIGNING_SECRET" },
    { name: "billing-webhook", kind: "webhook_secret", secretRef: "BILLING_WEBHOOK_SECRET" },
    { name: "datadog-webhook", kind: "webhook_secret", secretRef: "DATADOG_WEBHOOK_SECRET" },
    { name: "support-slack", kind: "slack_webhook", secretRef: "SLACK_SUPPORT_WEBHOOK_URL" },
  ];
  await insertChunked(credentials, CREDS.map((c, i) => ({
    id: uid("cred"), orgId: ORG, name: c.name, kind: c.kind, secretRef: c.secretRef,
    metadata: { seededBy: "seed-full", note: `${c.kind} for demo` }, createdBy: sample(adminIds),
    createdAt: daysAgo(randInt(20, 130)), updatedAt: daysAgo(randInt(0, 19)),
  })));

  await insertChunked(installedPlugins, ["slack", "github", "datadog", "pagerduty", "linear", "notion"].map((p) => ({
    id: uid("plug"), orgId: ORG, pluginId: p, configJson: { enabled: true, installedVia: "marketplace" },
    installedBy: sample(adminIds), createdAt: daysAgo(randInt(10, 120)),
  })));

  // --- workflows + versions + metadata + budgets + schedules --------------
  const WORKFLOW_DEFS = [
    { name: "Invoice approval pipeline", tags: ["finance", "approval"], sev: "p2" },
    { name: "Customer onboarding", tags: ["growth", "crm"], sev: "p3" },
    { name: "Refund processing", tags: ["finance", "support"], sev: "p1" },
    { name: "Nightly data sync", tags: ["data", "etl"], sev: "p3" },
    { name: "Lead enrichment", tags: ["growth", "ai"], sev: "p4" },
    { name: "Incident triage bot", tags: ["ops", "ai"], sev: "p1" },
    { name: "Weekly KPI report", tags: ["analytics", "report"], sev: "p3" },
    { name: "Contract review assistant", tags: ["legal", "ai"], sev: "p2" },
    { name: "Support ticket router", tags: ["support", "router"], sev: "p2" },
    { name: "Churn risk scoring", tags: ["analytics", "ai"], sev: "p3" },
    { name: "PO fulfilment sync", tags: ["ops", "etl"], sev: "p2" },
    { name: "Compliance audit export", tags: ["legal", "report"], sev: "p2" },
    { name: "Sales digest email", tags: ["growth", "email"], sev: "p4" },
    { name: "Fraud detection sweep", tags: ["security", "ai"], sev: "p1" },
    { name: "Inventory reorder", tags: ["ops", "etl"], sev: "p3" },
    { name: "NPS survey dispatch", tags: ["growth", "email"], sev: "p4" },
    { name: "Payroll reconciliation", tags: ["finance", "etl"], sev: "p1" },
    { name: "Vendor risk monitor", tags: ["security", "report"], sev: "p2" },
    { name: "Document OCR ingest", tags: ["data", "ai"], sev: "p3" },
    { name: "Renewal reminder flow", tags: ["growth", "email"], sev: "p3" },
    { name: "Helpdesk escalation", tags: ["support", "approval"], sev: "p2" },
    { name: "Marketing campaign sync", tags: ["growth", "crm"], sev: "p4" },
    { name: "Security alert fan-out", tags: ["security", "ops"], sev: "p1" },
    { name: "Quarterly board report", tags: ["analytics", "report"], sev: "p2" },
  ];

  function makeDag(wfId: string, name: string, variant: number) {
    const nodes: any[] = [{ id: "start", type: "noop", config: {} }];
    const edges: any[] = [];
    let prev = "start";
    const pieces: any[] = [
      { id: "fetch", type: "http", config: { url: "https://api.example.com/data", method: "GET", retry: { maxAttempts: 3 }, timeoutMs: 15000 } },
      { id: "classify", type: "ai", config: { prompt: "Classify the incoming record and extract key fields.", model: "anthropic/claude-haiku-4-5-20251001" } },
      { id: "shape", type: "transform", config: { mapping: { id: "{{fetch.id}}", label: "{{classify.label}}" } } },
      { id: "gate", type: "condition", config: { expression: "shape.label == 'urgent'" } },
      { id: "approval", type: "approval", config: { message: "Approve this action before it runs?" } },
      { id: "notify", type: "tool", config: { tool: "slack.post", input: { credentialName: "incidents-slack", text: "Workflow {{name}} completed" } } },
    ];
    const count = 3 + (variant % 4);
    for (let i = 0; i < count; i++) {
      const p = pieces[i % pieces.length]!;
      const node = { id: `${p.id}_${i}`, type: p.type, config: p.config };
      nodes.push(node);
      edges.push({ from: prev, to: node.id, ...(p.type === "condition" ? {} : {}) });
      prev = node.id;
    }
    const done = { id: "done", type: "noop", config: {} };
    nodes.push(done);
    edges.push({ from: prev, to: done.id });
    return { dslVersion: "1.0", id: wfId, name, nodes, edges, outputs: { status: "{{done.status}}" } };
  }

  type WfRef = { id: string; name: string; latestVersionId: string; versions: { id: string; version: number }[]; sev: string; tags: string[]; hasSchedule: boolean; scheduleNode?: string };
  const wfRefs: WfRef[] = [];

  const wfRows: any[] = [];
  const versionRows: any[] = [];
  const metaRows: any[] = [];
  const budgetRows: any[] = [];
  const scheduleRows: any[] = [];

  WORKFLOW_DEFS.forEach((def, idx) => {
    const wfId = uid("wf");
    const createdAt = daysAgo(randInt(40, 160));
    wfRows.push({ id: wfId, orgId: ORG, name: def.name, createdBy: sample(adminIds), createdAt });

    const nVersions = randInt(1, 4);
    const versions: { id: string; version: number }[] = [];
    for (let v = 1; v <= nVersions; v++) {
      const vid = `${wfId}__v${v}`;
      const slo = chance(0.5) ? { successRatePercent: sample([95, 97, 99]), p95DurationMs: sample([30000, 60000, 120000]), windowDays: sample([7, 14, 30]) } : null;
      versionRows.push({
        id: vid, orgId: ORG, workflowId: wfId, version: v,
        dagJson: makeDag(wfId, def.name, idx + v), sloJson: slo,
        createdBy: sample(adminIds), createdAt: new Date(createdAt.getTime() + v * 86_400_000 * randInt(1, 10)),
      });
      versions.push({ id: vid, version: v });
    }
    const latest = versions[versions.length - 1]!;

    // metadata for most workflows
    if (chance(0.75)) {
      metaRows.push({
        id: uid("wfmeta"), orgId: ORG, workflowId: wfId,
        owners: [sample(adminIds), someUser()],
        runbookMarkdown: `# ${def.name} runbook\n\n## On failure\n1. Check the **DLQ** panel for the failing node.\n2. Inspect upstream credential health.\n3. If transient, replay from Recovery Center.\n\n> Owner is paged via ${sample(["#ops", "#oncall", "#incidents"])}.`,
        description: `Operational metadata for the ${def.name.toLowerCase()} workflow.`,
        tags: def.tags, slackChannel: `#${def.tags[0]}-alerts`,
        linearProject: `https://linear.app/janusly/project/${def.tags[0]}`,
        severityDefault: def.sev, createdBy: sample(adminIds),
        createdAt, updatedAt: daysAgo(randInt(1, 30)),
      });
    }
    // budgets for ~half
    if (chance(0.5)) {
      budgetRows.push({
        id: uid("bud"), orgId: ORG, workflowId: wfId,
        monthlyUsd: sample([25, 50, 100, 250]), warnPercent: sample([70, 80, 90]),
        policy: chance(0.3) ? "block" : "warn", updatedBy: sample(adminIds),
        createdAt, updatedAt: daysAgo(randInt(1, 20)),
      });
    }
    // schedules for ~40%
    let hasSchedule = false; let scheduleNode: string | undefined;
    if (chance(0.4)) {
      hasSchedule = true; scheduleNode = "start";
      scheduleRows.push({
        id: uid("sched"), orgId: ORG, workflowId: wfId, workflowVersionId: latest.id, nodeId: "start",
        cronExpression: sample(["0 3 * * *", "*/15 * * * *", "0 9 * * 1", "0 0 1 * *", "0 */6 * * *"]),
        enabled: chance(0.8), lastRunAt: chance(0.7) ? hoursAgo(randInt(1, 72)) : null,
        lastRunId: null, createdBy: sample(adminIds), createdAt, updatedAt: daysAgo(randInt(1, 15)),
      });
    }

    wfRefs.push({ id: wfId, name: def.name, latestVersionId: latest.id, versions, sev: def.sev, tags: def.tags, hasSchedule, scheduleNode });
  });

  await insertChunked(workflows, wfRows);
  await insertChunked(workflowVersions, versionRows);
  await insertChunked(workflowMetadata, metaRows);
  await insertChunked(workflowBudgets, budgetRows);
  await insertChunked(scheduleEntries, scheduleRows);
  console.log(`[seed-full] workflows: ${wfRows.length}, versions: ${versionRows.length}, schedules: ${scheduleRows.length}`);

  // --- routing stats + improvements ---------------------------------------
  await insertChunked(routingStats, wfRefs.flatMap((wf) =>
    ["gate_3", "router_a", "router_b"].slice(0, randInt(1, 3)).map((node) => {
      const pulls = randInt(20, 400); const success = randInt(0, pulls);
      return {
        id: uid("rstat"), orgId: ORG, nodeId: `${wf.id}:${node}`, pulls,
        value: round2(rng() * 10), meanReward: round2(rng()), successCount: success,
        failureCount: pulls - success, updatedAt: daysAgo(randInt(0, 20)),
      };
    })
  ));

  await insertChunked(workflowImprovements, wfRefs.slice(0, 18).map((wf) => {
    const status = sample(["pending", "applied", "rejected", "pending"]);
    return {
      id: uid("imp"), orgId: ORG, workflowId: wf.id, baseVersion: 1, newVersion: 2,
      action: { kind: "raise_timeout", node: "fetch_1", from: 15000, to: 30000 },
      reason: sample(["High p95 latency on the HTTP fetch node.", "Repeated transient timeouts under load.", "Approval gate added for write-side action.", "Retry policy tuned after DLQ clustering."]),
      beforeMetrics: { successRate: round2(0.7 + rng() * 0.2), p95Ms: randInt(20000, 60000) },
      afterMetrics: { successRate: round2(0.9 + rng() * 0.09), p95Ms: randInt(8000, 20000) },
      confidence: round2(0.5 + rng() * 0.49), status, createdAt: daysAgo(randInt(1, 50)),
    };
  }));

  // --- runs + run_nodes + run_events --------------------------------------
  const RUN_STATUSES = ["succeeded", "succeeded", "succeeded", "succeeded", "failed", "failed", "running", "cancelled", "waiting"];
  type RunRef = { id: string; wf: WfRef; status: string; createdAt: Date; failingNode?: string };
  const runRefs: RunRef[] = [];
  const runRows: any[] = [];
  const nodeRows: any[] = [];
  const eventRows: any[] = [];
  const TOTAL_RUNS = 420;

  for (let i = 0; i < TOTAL_RUNS; i++) {
    const wf = sample(wfRefs);
    const ver = sample(wf.versions);
    const status = sample(RUN_STATUSES);
    const createdAt = daysAgo(rng() * 75);
    const runId = uid("run");
    const dag = versionRows.find((r) => r.id === ver.id)!.dagJson;
    const nodeList: any[] = dag.nodes;

    runRows.push({
      id: runId, orgId: ORG, workflowVersionId: ver.id, status,
      inputJson: { trigger: sample(["schedule", "manual", "webhook", "api"]), recordId: uid("rec") },
      outputJson: status === "succeeded" ? { status: "ok", processed: randInt(1, 200) } : null,
      replayMode: null, createdBy: chance(0.3) ? "schedule" : someUser(), createdAt,
    });

    eventRows.push({ id: `${runId}__e_started`, runId, nodeId: null, type: "run.started", payload: {}, createdAt });

    // emit detailed node/events for ~35% of runs (keeps row count sane but timelines rich)
    const detailed = i % 3 === 0;
    let failingNode: string | undefined;
    if (detailed) {
      const failAt = status === "failed" ? randInt(1, Math.max(1, nodeList.length - 2)) : -1;
      nodeList.forEach((n: any, ni: number) => {
        const isFail = ni === failAt;
        if (isFail) failingNode = n.id;
        const nodeStatus = isFail ? "failed" : ni <= (failAt === -1 ? nodeList.length : failAt) ? "completed" : "pending";
        const start = new Date(createdAt.getTime() + ni * 1500);
        nodeRows.push({
          id: `${runId}__${n.id}`, runId, nodeId: n.id, status: nodeStatus,
          stateJson: nodeStatus === "completed" ? { output: { ok: true, ms: randInt(20, 4000) } } : {},
          attempts: isFail ? 3 : 1, startedAt: start,
          finishedAt: nodeStatus === "pending" ? null : new Date(start.getTime() + randInt(50, 3000)),
          errorJson: isFail ? { message: sample(["HTTP 503 from upstream", "credential secret missing for bot-github", "ETIMEDOUT after 30000ms", "AI provider rate limited"]), code: sample(["upstream_5xx", "secret_missing", "network_timeout", "ai_provider"]) } : null,
        });
        eventRows.push({ id: `${runId}__${n.id}__c`, runId, nodeId: n.id, type: isFail ? "node.failed" : "node.completed", payload: isFail ? { error: { message: "see error_json" } } : { ok: true }, createdAt: new Date(start.getTime() + 100) });
      });
    } else if (status === "failed") {
      failingNode = sample(nodeList.filter((n: any) => n.type !== "noop")).id ?? "fetch_1";
    }

    if (status !== "running" && status !== "waiting") {
      eventRows.push({ id: `${runId}__e_term`, runId, nodeId: null, type: status === "succeeded" ? "run.succeeded" : status === "failed" ? "run.failed" : "run.cancelled", payload: {}, createdAt: new Date(createdAt.getTime() + 60000) });
    }

    runRefs.push({ id: runId, wf, status, createdAt, failingNode });
  }
  await insertChunked(runs, runRows);
  await insertChunked(runNodes, nodeRows, 500);
  await insertChunked(runEvents, eventRows, 500);
  console.log(`[seed-full] runs: ${runRows.length}, run_nodes: ${nodeRows.length}, run_events: ${eventRows.length}`);

  // --- dead_letters + recovery_items + children + handoffs + feedback -----
  const failedRuns = runRefs.filter((r) => r.status === "failed");
  const dlqRows: any[] = [];
  const recoveryRows: any[] = [];
  const childRows: any[] = [];
  const handoffRows: any[] = [];
  const feedbackRows: any[] = [];
  const healingRows: any[] = [];

  const SIGNATURES = [
    "HTTP 503 on http node", "Missing secret: GITHUB_TOKEN", "Network timeout after 30000ms",
    "AI provider rate limited", "Parse error: invalid JSON", "Tool input invalid: search is required",
  ];
  const APPROACH = ["add_retry", "raise_timeout", "swap_secret_ref", "add_approval", "fix_url", "other"] as const;
  const RES_REASONS = ["fixed_by_patch", "rolled_back", "upstream_fixed", "accepted_loss", "not_a_bug", "sandbox_replay_succeeded"];
  const HANDOFF_DESTS = ["slack", "linear", "github", "webhook"];

  const dlqTargets = failedRuns.slice(0, 48);
  dlqTargets.forEach((r, i) => {
    const dlqId = uid("dlq");
    const node = r.failingNode ?? "fetch_1";
    const sig = sample(SIGNATURES);
    const dlqStatus = i < 30 ? "open" : i < 40 ? "replayed" : "resolved";
    const dag = versionRows.find((v) => v.workflowId === r.wf.id)!.dagJson;
    const nodeJson = dag.nodes.find((n: any) => n.id === node) ?? { id: node, type: "http", config: {} };
    dlqRows.push({
      id: dlqId, orgId: ORG, runId: r.id, nodeId: node, attempt: 3,
      workflowJson: dag, nodeJson, errorJson: { message: sig, code: sample(["upstream_5xx", "secret_missing", "network_timeout"]), signature: sig },
      status: dlqStatus, replayedAt: dlqStatus === "replayed" ? hoursAgo(randInt(1, 48)) : null,
      createdAt: r.createdAt,
    });

    // recovery item per DLQ row (auto-created)
    const sev = (r.wf.sev as string) || "p3";
    const slaSecs = { p1: 3600, p2: 14400, p3: 86400, p4: 604800 }[sev] ?? 86400;
    const itemStatus = dlqStatus === "open"
      ? sample(["open", "acknowledged", "in_progress", "waiting_external"])
      : "resolved";
    const owner = chance(0.7) ? sample(members).userId : null;
    const itemId = uid("recitem");
    const comments = chance(0.5)
      ? Array.from({ length: randInt(1, 3) }, (_, ci) => ({
          id: uid("cmt"), authorUserId: sample(members).userId,
          body: sample(["Looking into this now.", "Upstream confirmed an outage.", "Replayed in sandbox — green.", "Paging the on-call owner.", "Root cause is a rotated token."]),
          createdAt: hoursAgo(randInt(1, 40)).toISOString(),
        }))
      : [];
    recoveryRows.push({
      id: itemId, orgId: ORG, deadLetterId: dlqId, workflowId: r.wf.id, owner,
      severity: sev, status: itemStatus, slaTargetAt: new Date(r.createdAt.getTime() + slaSecs * 1000),
      resolutionReason: itemStatus === "resolved" ? sample(RES_REASONS) : null,
      resolvedBy: itemStatus === "resolved" ? sample(adminIds) : null,
      resolvedAt: itemStatus === "resolved" ? hoursAgo(randInt(1, 60)) : null,
      comments, errorSignature: sig, occurrenceCount: randInt(1, 6),
      firstOccurredAt: r.createdAt, lastOccurredAt: hoursAgo(randInt(1, 50)),
      createdBy: "system", createdAt: r.createdAt, updatedAt: hoursAgo(randInt(0, 24)),
    });

    // failure-storm children for some
    if (chance(0.35)) {
      childRows.push({ id: uid("recchild"), orgId: ORG, recoveryItemId: itemId, deadLetterId: uid("dlqchild"), occurredAt: hoursAgo(randInt(1, 30)) });
    }
    // handoffs for some
    if (chance(0.3)) {
      const dest = sample(HANDOFF_DESTS);
      const credForDest = dest === "github" ? "bot-github" : dest === "slack" ? "incidents-slack" : "partner-webhook";
      handoffRows.push({
        id: uid("handoff"), orgId: ORG, recoveryItemId: itemId, destination: dest, credentialName: credForDest,
        externalId: dest === "github" ? String(randInt(100, 999)) : uid("ext"),
        externalUrl: dest === "github" ? `https://github.com/janusly/ops/issues/${randInt(100, 999)}` : dest === "linear" ? `https://linear.app/janusly/issue/OPS-${randInt(100, 999)}` : null,
        idempotencyKey: `${itemId}:${dest}`, lastOutcome: chance(0.85) ? "delivered" : "delivery_failed",
        lastStatusCode: chance(0.85) ? 200 : 500, lastError: null, lastLatencyMs: randInt(80, 1200),
        dispatchCount: randInt(1, 3), firstDispatchedAt: hoursAgo(randInt(10, 60)), lastDispatchedAt: hoursAgo(randInt(1, 9)), createdBy: sample(adminIds),
      });
    }

    // recovery feedback (operator decisions)
    if (chance(0.7)) {
      const accepted = chance(0.6);
      feedbackRows.push({
        id: uid("fb"), orgId: ORG, userId: sample(members).userId, deadLetterId: dlqId, workflowId: r.wf.id,
        suggestionMode: chance(0.8) ? "ai" : "fallback", approachLabel: sample(APPROACH), accepted,
        comment: accepted ? null : sample(["validation_failed", "Suggestion changed the wrong node.", "Too risky without an approval gate."]),
        createdAt: hoursAgo(randInt(1, 70)),
      });
    }

    // auto-healing ledger row
    const healStatus = sample(["diagnosed", "proposed", "validating", "validated", "validation_failed", "applied", "declined"]);
    healingRows.push({
      id: uid("heal"), orgId: ORG, deadLetterId: dlqId, signature: sig, status: healStatus,
      proposedPatchJson: ["proposed", "validated", "applied"].includes(healStatus) ? { patched: true, node } : null,
      approachLabel: sample(APPROACH), confidence: randInt(40, 98),
      validationRunId: ["validated", "applied", "validation_failed"].includes(healStatus) ? uid("vrun") : null,
      validationSignature: healStatus === "validation_failed" ? sample(SIGNATURES) : null,
      decisionActor: healStatus === "applied" ? "auto" : healStatus === "declined" ? sample(adminIds) : null,
      declineReason: healStatus === "declined" ? sample(["manual_review", "budget_exceeded", "loop_breaker_tripped", "signature_changed"]) : null,
      loopAttemptCount: randInt(1, 3), metadata: { source: "scanner" },
      createdAt: r.createdAt, updatedAt: hoursAgo(randInt(0, 30)),
    });
  });
  await insertChunked(deadLetters, dlqRows);
  await insertChunked(recoveryItems, recoveryRows);
  await insertChunked(recoveryItemChildren, childRows);
  await insertChunked(recoveryItemHandoffs, handoffRows);
  await insertChunked(recoveryFeedback, feedbackRows);
  await insertChunked(autoHealingRuns, healingRows);
  console.log(`[seed-full] dlq: ${dlqRows.length}, recovery_items: ${recoveryRows.length}, handoffs: ${handoffRows.length}, feedback: ${feedbackRows.length}, auto_healing: ${healingRows.length}`);

  // --- alert policies + dispatches ----------------------------------------
  const TRIGGERS: { trigger: string; params: any }[] = [
    { trigger: "dlq.entry_created", params: { errorSignaturePattern: "Missing secret:*", workflowIds: [] } },
    { trigger: "dlq.entry_created", params: {} },
    { trigger: "failure_cluster.threshold", params: { minFrequency: 5, windowDays: 7 } },
    { trigger: "failure_cluster.threshold", params: { minFrequency: 3, windowDays: 14 } },
    { trigger: "budget.blocked", params: { scope: "org" } },
    { trigger: "budget.blocked", params: { scope: "workflow", workflowIds: [wfRefs[0]!.id] } },
    { trigger: "limiter.degraded", params: { buckets: [] } },
    { trigger: "workflow.slo_breach", params: { metricNames: ["successRate", "p95"], workflowIds: [] } },
    { trigger: "approval.stalled", params: { stalledMinutes: 60, workflowIds: [] } },
    { trigger: "approval.stalled", params: { stalledMinutes: 240 } },
    { trigger: "recovery_item.created", params: { severities: ["p1", "p2"] } },
    { trigger: "recovery_item.created", params: { severities: ["p1"] } },
    { trigger: "recovery_item.sla_breached", params: { severities: ["p1", "p2", "p3"] } },
    { trigger: "recovery_item.sla_breached", params: { severities: ["p1"] } },
    { trigger: "dlq.entry_created", params: { workflowIds: [wfRefs[2]!.id, wfRefs[5]!.id] } },
    { trigger: "failure_cluster.threshold", params: { minFrequency: 10, windowDays: 30 } },
  ];
  const policyRows: any[] = [];
  const dispatchRows: any[] = [];
  TRIGGERS.forEach((t, i) => {
    const policyId = uid("alpol");
    const destKind = sample(["slack", "github", "webhook", "email"]);
    const channels = [
      { destination: destKind, credentialName: destKind === "github" ? "bot-github" : destKind === "slack" ? "alerts-slack" : "partner-webhook", params: destKind === "github" ? { owner: "janusly", repo: "ops" } : destKind === "slack" ? { channel: "#alerts" } : destKind === "webhook" ? { url: "https://hooks.example.com/janusly" } : { to: "oncall@janusly.dev", subject: "Janusly alert" } },
    ];
    if (chance(0.4)) channels.push({ destination: "slack", credentialName: "incidents-slack", params: { channel: "#incidents" } });
    policyRows.push({
      id: policyId, orgId: ORG, name: `${t.trigger} · policy ${i + 1}`, trigger: t.trigger,
      parameters: t.params, channels, cooldownSeconds: sample([300, 900, 1800, 3600]),
      enabled: chance(0.85), createdBy: sample(adminIds), createdAt: daysAgo(randInt(10, 90)), updatedAt: daysAgo(randInt(1, 9)),
    });
    // dispatches per policy
    const nDisp = randInt(2, 8);
    for (let d = 0; d < nDisp; d++) {
      const ok = chance(0.8);
      dispatchRows.push({
        id: uid("aldisp"), orgId: ORG, policyId, dedupeKey: `${t.trigger}:${uid("dk")}`,
        dispatchedAt: hoursAgo(randInt(1, 600)), outcome: ok ? "delivered" : "delivery_failed",
        channelResults: channels.map((c) => ({ destination: c.destination, credentialName: c.credentialName, ok, statusCode: ok ? 200 : 500, error: ok ? undefined : "upstream 500", latencyMs: randInt(50, 1500) })),
        triggerPayload: { trigger: t.trigger, sample: true, workflowId: sample(wfRefs).id },
      });
    }
  });
  await insertChunked(alertPolicies, policyRows);
  await insertChunked(alertDispatches, dispatchRows);
  console.log(`[seed-full] alert_policies: ${policyRows.length}, alert_dispatches: ${dispatchRows.length}`);

  // --- usage events (billing + value dashboards) --------------------------
  const usageRows: any[] = [];
  const MODELS = ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "gpt-4o-mini"];
  const TOOL_METRICS = ["tool.slack.post", "tool.github.create_issue", "tool.webhook.send", "tool.pdf.generate", "email.sent", "pdf.generated"];
  // ~2200 llm.completion events spread over 45 days
  for (let i = 0; i < 2200; i++) {
    const wf = sample(wfRefs);
    const model = sample(MODELS);
    const inTok = randInt(200, 4000), outTok = randInt(50, 1500);
    const cost = round2(((inTok / 1000) * 0.0008 + (outTok / 1000) * 0.004) * 100) / 100 || round2((inTok + outTok) / 1_000_000 * 3);
    const createdAt = daysAgo(rng() * 45);
    usageRows.push({
      id: uid("use"), orgId: ORG, userId: someUser(), runId: chance(0.7) ? sample(runRefs).id : null,
      metric: "llm.completion", quantity: inTok + outTok,
      metadata: { provider: model.startsWith("gpt") ? "openai" : "anthropic", model, inputTokens: inTok, outputTokens: outTok, latencyMs: randInt(300, 6000), costUsd: cost, nodeId: "classify_1", workflowId: wf.id, mode: chance(0.95) ? "ai" : "fallback" },
      createdAt,
    });
  }
  // ~900 tool / email / pdf usage events
  for (let i = 0; i < 900; i++) {
    const wf = sample(wfRefs);
    const metric = sample(TOOL_METRICS);
    const ok = chance(0.85);
    usageRows.push({
      id: uid("use"), orgId: ORG, userId: someUser(), runId: chance(0.6) ? sample(runRefs).id : null,
      metric, quantity: 1,
      metadata: { tool: metric, ok, statusCode: ok ? 200 : 500, error: ok ? undefined : "upstream error", latencyMs: randInt(40, 2500), workflowId: wf.id, nodeId: "notify_5", costUsd: metric === "pdf.generated" ? 0 : undefined },
      createdAt: daysAgo(rng() * 45),
    });
  }
  await insertChunked(usageEvents, usageRows, 500);
  console.log(`[seed-full] usage_events: ${usageRows.length}`);

  // --- audit logs ---------------------------------------------------------
  const AUDIT_ACTIONS = [
    "workflow.saved", "workflow.deleted", "run.started", "dlq.replayed", "dlq.resolved",
    "member.joined", "member.role_set", "org.config.write", "credential.created", "credential.bulk_updated",
    "alert.policy.created", "alert.policy.updated", "alert.policy.triggered", "alert.policy.suppressed",
    "recovery.item.created", "recovery.item.acknowledged", "recovery.item.in_progress", "recovery.item.resolved",
    "recovery.feedback", "recovery.cluster_apply", "recovery.validation_started",
    "ai.workflow.generated", "ai.workflow.explained", "ai.workflow.reviewed", "ai.workflow.patch_suggested",
    "ai.workflow.improvement_suggested", "ai.run.explained",
    "billing.budget.configured", "billing.budget.warned", "billing.budget.exceeded",
    "mcp.connection.created", "mcp.connection.updated", "mcp.tool.enabled", "mcp.tool.disabled",
    "auto_healing.diagnosed", "auto_healing.proposed", "auto_healing.validated", "auto_healing.applied", "auto_healing.declined",
    "prompt.created", "prompt.version_created", "prompt.version_pinned",
    "org.role.created", "org.role.updated", "org.permissions.override_set",
    "report.run_explain.exported", "report.value_dashboard.exported",
    "org.scim.directory_attached", "scim.user.provisioned", "auth.sso.login",
  ];
  const auditRows: any[] = [];
  for (let i = 0; i < 620; i++) {
    const action = sample(AUDIT_ACTIONS);
    const wf = sample(wfRefs);
    auditRows.push({
      id: uid("aud"), orgId: ORG, userId: chance(0.85) ? sample(members).userId : null, action,
      targetType: action.startsWith("workflow") ? "workflow" : action.startsWith("recovery") ? "recovery_item" : action.startsWith("member") ? "member" : action.startsWith("alert") ? "alert_policy" : "system",
      targetId: action.startsWith("workflow") ? wf.id : uid("tgt"),
      metadata: { source: sample(["web", "mcp", "service"]), actor: { mode: sample(["dev-headers", "supabase", "service-token"]) }, note: `${action} demo event` },
      createdAt: daysAgo(rng() * 60),
    });
  }
  await insertChunked(auditLogs, auditRows, 500);
  console.log(`[seed-full] audit_logs: ${auditRows.length}`);

  // --- MCP connections + tool descriptors ---------------------------------
  const MCP_DEFS = [
    { alias: "notion", transport: "http", url: "https://mcp.notion.com/mcp", status: "active", expose: true, tools: ["search", "fetch", "create-pages", "update-page"] },
    { alias: "github-mcp", transport: "http", url: "https://api.githubcopilot.com/mcp/", status: "active", expose: true, tools: ["list_issues", "create_issue", "get_pull_request"] },
    { alias: "filesystem", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], status: "active", expose: false, tools: ["read_file", "write_file", "list_directory"] },
    { alias: "postgres-ro", transport: "stdio", command: "uvx", args: ["mcp-server-postgres"], status: "active", expose: false, tools: ["query", "list_schemas"] },
    { alias: "legacy-sse", transport: "sse", url: "https://legacy.example.com/sse", status: "failed", expose: false, tools: [] },
    { alias: "linear-mcp", transport: "http", url: "https://mcp.linear.app/mcp", status: "pending", expose: false, tools: [] },
  ];
  const mcpConnRows: any[] = [];
  const mcpToolRows: any[] = [];
  MCP_DEFS.forEach((m) => {
    const connId = uid("mcpconn");
    mcpConnRows.push({
      id: connId, orgId: ORG, alias: m.alias, transport: m.transport,
      command: (m as any).command ?? null, args: (m as any).args ?? null, url: (m as any).url ?? null,
      envRefs: m.transport === "http" && m.alias === "notion" ? { NOTION_TOKEN: { kind: "env", name: "NOTION_MCP_TOKEN" } } : {},
      enabled: m.status !== "disabled", status: m.status, statusReason: m.status === "failed" ? "discovery failed: connection refused" : null,
      exposeToAi: m.expose, lastDiscoveryAt: m.status === "active" ? hoursAgo(randInt(1, 72)) : null,
      createdBy: sample(adminIds), createdAt: daysAgo(randInt(10, 80)), updatedAt: daysAgo(randInt(0, 9)),
    });
    m.tools.forEach((tool, ti) => {
      const writeSide = /create|write|update|delete/.test(tool);
      mcpToolRows.push({
        id: uid("mcptool"), connectionId: connId, name: tool,
        description: `${tool.replace(/[_-]/g, " ")} via ${m.alias}`,
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: writeSide ? [] : ["query"] },
        writeSide, enabled: ti < 3, rateLimitPerMin: chance(0.3) ? sample([30, 120, 300]) : null,
        exposeToAi: m.expose && ti < 2, createdAt: daysAgo(randInt(5, 60)), updatedAt: daysAgo(randInt(0, 4)),
      });
    });
  });
  await insertChunked(mcpConnections, mcpConnRows);
  await insertChunked(mcpToolDescriptors, mcpToolRows);
  console.log(`[seed-full] mcp_connections: ${mcpConnRows.length}, mcp_tool_descriptors: ${mcpToolRows.length}`);

  // --- prompts + versions -------------------------------------------------
  const PROMPT_DEFS = [
    { name: "triage-classifier", desc: "Classify incoming incidents by severity", body: "You are an incident triage assistant. Classify the following report:\n\n{{var.report}}\n\nSeverity guidance:\n{{include.severity-rubric}}", vars: [{ name: "report", type: "string", required: true }] },
    { name: "severity-rubric", desc: "Shared severity rubric (include)", body: "p1 = customer-facing outage; p2 = degraded; p3 = internal; p4 = cosmetic.", vars: [] },
    { name: "refund-explainer", desc: "Explain a refund decision to the customer", body: "Write a friendly explanation for refund {{var.refundId}} totalling {{var.amount}}.", vars: [{ name: "refundId", type: "string", required: true }, { name: "amount", type: "number", required: true }] },
    { name: "contract-summary", desc: "Summarize a contract's key terms", body: "Summarize the key obligations, termination clauses, and renewal terms of:\n\n{{var.contract}}", vars: [{ name: "contract", type: "string", required: true }] },
    { name: "lead-enricher", desc: "Enrich a sales lead", body: "Given {{var.company}}, infer industry, size band, and likely pain points.", vars: [{ name: "company", type: "string", required: true }] },
    { name: "kpi-narrative", desc: "Turn KPI numbers into a narrative", body: "Write a 3-paragraph executive narrative from this KPI JSON:\n{{var.kpis}}", vars: [{ name: "kpis", type: "json", required: true }] },
    { name: "churn-reasoner", desc: "Explain churn-risk scores", body: "Explain why account {{var.account}} has churn risk {{var.score}}.", vars: [{ name: "account", type: "string", required: true }, { name: "score", type: "number", required: true }] },
    { name: "router-policy", desc: "Routing policy for support tickets", body: "Route to billing, technical, or general based on:\n{{var.ticket}}", vars: [{ name: "ticket", type: "string", required: true }] },
    { name: "alert-summarizer", desc: "Summarize a burst of alerts", body: "Condense these {{var.count}} alerts into one on-call summary:\n{{var.alerts}}", vars: [{ name: "count", type: "number", required: false, defaultValue: 0 }, { name: "alerts", type: "string", required: true }] },
  ];
  const promptRows: any[] = [];
  const promptVerRows: any[] = [];
  PROMPT_DEFS.forEach((p) => {
    const promptId = uid("prompt");
    const nV = randInt(1, 3);
    let pinned: string | null = null;
    for (let v = 1; v <= nV; v++) {
      const vid = uid("pver");
      promptVerRows.push({
        id: vid, orgId: ORG, promptId, version: v,
        templateText: v === nV ? p.body : `${p.body}\n\n(rev ${v})`,
        variables: p.vars, status: "published", createdBy: sample(adminIds),
        createdAt: daysAgo(randInt(5, 90) - v),
      });
      if (v === nV && chance(0.5)) pinned = vid;
    }
    promptRows.push({ id: promptId, orgId: ORG, name: p.name, description: p.desc, pinnedVersionId: pinned, createdBy: sample(adminIds), createdAt: daysAgo(randInt(20, 100)), updatedAt: daysAgo(randInt(1, 19)) });
  });
  await insertChunked(prompts, promptRows);
  await insertChunked(promptVersions, promptVerRows);
  console.log(`[seed-full] prompts: ${promptRows.length}, prompt_versions: ${promptVerRows.length}`);

  // --- memory entries (vector) --------------------------------------------
  const MEM_KINDS = ["recovery_rationale", "run_summary", "runbook_fragment", "patch_rationale"];
  const memRows: any[] = [];
  for (let i = 0; i < 50; i++) {
    const wf = sample(wfRefs);
    const kind = sample(MEM_KINDS);
    memRows.push({
      id: uid("mem_e"), orgId: ORG, workflowId: wf.id, runId: chance(0.6) ? sample(runRefs).id : null,
      kind, content: sample([
        "Raising the HTTP timeout from 15s to 30s resolved repeated upstream 503s on this workflow.",
        "Operator rolled back to v2 after the new transform dropped the customer id field.",
        "Runbook: on credential_missing, rotate the bot-github secret and replay from the DLQ.",
        "Adding an approval gate before the write-side Slack post stopped accidental fan-out.",
        "Run completed in 4.2s; the AI classify step accounted for 70% of latency.",
      ]),
      embedding: fakeEmbedding(i + 1),
      embeddingProvider: "ollama", embeddingModel: "bge-m3", embeddingDimension: 1024,
      metadata: { workflowName: wf.name, source: "seed-full" },
      createdAt: daysAgo(randInt(1, 80)), retainUntil: daysFromNow(randInt(30, 180)),
    });
  }
  await insertChunked(memoryEntries, memRows, 100);
  console.log(`[seed-full] memory_entries: ${memRows.length}`);

  console.log(`\n[seed-full] ✅ done for org="${ORG}". Open http://localhost:5173 (org "${ORG}") to browse.`);
}

seed()
  .then(async () => {
    await client.end({ timeout: 5 });
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("[seed-full] failed:", error);
    try { await client.end({ timeout: 5 }); } catch {}
    process.exit(1);
  });
