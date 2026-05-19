/**
 * Idempotent dev seeder for the canonical demo recordings. Writes the
 * three credential rows the flagship demos consume so a presenter can
 * spin up a recording-ready dev environment in a single command instead
 * of clicking through the Connections panel three times.
 *
 * Usage:
 *   pnpm seed:demos                  # no-op-if-exists (safe default)
 *   pnpm seed:demos -- --force       # delete + reinsert (clean slate)
 *   pnpm seed:demos -- --org=my-org  # target a non-default org
 *
 * Run while the dev DB is up (`pnpm dev` or Compose alone). Refuses to
 * run when JANUSLY_PRODUCTION_MODE=true so a misconfigured CI cannot
 * touch real customer credentials.
 *
 * Inserts exactly three rows in `credentials`; nothing else is touched.
 * Workflows / runs / DLQ / templates are NOT seeded — presenters load
 * the demo templates from the AI Studio Recipes panel during recording.
 */

import { and, eq, inArray } from "drizzle-orm";
import { credentials, db } from "@janusly/db";

type Mode = "noop-if-exists" | "force";

type SeedCredential = {
  name: string;
  kind: string;
  secretRef: string;
};

const DEMO_CREDENTIALS: readonly SeedCredential[] = [
  { name: "bot-github", kind: "github_token", secretRef: "JANUSLY_DEMO_GITHUB_TOKEN" },
  { name: "incidents-slack", kind: "slack_webhook", secretRef: "JANUSLY_DEMO_SLACK_WEBHOOK" },
  { name: "partner-webhook", kind: "webhook_secret", secretRef: "JANUSLY_DEMO_WEBHOOK_SECRET" },
] as const;

const SEEDER_USER_ID = "demo-seeder";

function parseOrgId(): string {
  const arg = process.argv.find((a) => a.startsWith("--org="));
  return arg ? arg.slice("--org=".length) : "default";
}

function parseMode(): Mode {
  return process.argv.includes("--force") ? "force" : "noop-if-exists";
}

function assertNotProduction(): void {
  if (process.env.JANUSLY_PRODUCTION_MODE === "true") {
    console.error("[seed-demos] refusing to run with JANUSLY_PRODUCTION_MODE=true — this seeder is dev-only.");
    process.exit(1);
  }
}

async function seed(): Promise<void> {
  assertNotProduction();

  const orgId = parseOrgId();
  const mode = parseMode();
  const names = DEMO_CREDENTIALS.map((row) => row.name);

  console.log(`[seed-demos] org=${orgId} mode=${mode}`);

  const existing = await db
    .select({ id: credentials.id, name: credentials.name })
    .from(credentials)
    .where(and(eq(credentials.orgId, orgId), inArray(credentials.name, names)));
  const existingNames = new Set(existing.map((row) => row.name));

  if (mode === "force" && existing.length > 0) {
    await db
      .delete(credentials)
      .where(and(eq(credentials.orgId, orgId), inArray(credentials.name, names)));
    console.log(`[seed-demos] --force: deleted ${existing.length} prior row(s)`);
    existingNames.clear();
  }

  let inserted = 0;
  let skipped = 0;
  for (const row of DEMO_CREDENTIALS) {
    if (existingNames.has(row.name)) {
      console.log(`[seed-demos] ✓ ${row.name.padEnd(20)} already exists (kind=${row.kind}) — skipped`);
      skipped += 1;
      continue;
    }
    const id = crypto.randomUUID();
    await db.insert(credentials).values({
      id,
      orgId,
      name: row.name,
      kind: row.kind,
      secretRef: row.secretRef,
      metadata: { seededBy: "seed-demos" },
      createdBy: SEEDER_USER_ID,
    });
    console.log(`[seed-demos] + ${row.name.padEnd(20)} kind=${row.kind.padEnd(16)} secretRef=${row.secretRef}`);
    inserted += 1;
  }

  console.log(`[seed-demos] done — inserted=${inserted} skipped=${skipped} for org=${orgId}.`);
  if (skipped > 0 && mode === "noop-if-exists") {
    console.log(`[seed-demos] tip: re-run with --force to reset existing demo credentials.`);
  }
  console.log(`\nNext steps for the recording presenter:`);
  console.log(`  1. Open the web UI (pnpm dev → http://localhost:5173).`);
  console.log(`  2. Recipes → click a flagship recipe → Use recipe → Save.`);
  console.log(`  3. Follow docs/marketing/recording-scripts/<demo>.md beat-by-beat.`);
}

seed()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[seed-demos] failed:", error);
    process.exit(1);
  });
