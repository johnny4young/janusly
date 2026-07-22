/**
 * Idempotent bootstrap for the isolated local Docker stack.
 *
 * This inserts only credential references and the safe sender address; secret
 * values remain in container environment variables. It refuses to run unless
 * the dedicated local-stack marker is present.
 */

import { and, eq, inArray } from "drizzle-orm";
import { credentials, db } from "@janusly/db";
import { upsertOrgConfig } from "@janusly/data";

const orgId = process.env.JANUSLY_LOCAL_ORG_ID?.trim() || "default";
const marker = process.env.JANUSLY_LOCAL_STACK;

if (marker !== "true") {
  throw new Error("seed-local-lab requires JANUSLY_LOCAL_STACK=true");
}

const desired = [
  { name: "billing_webhook", kind: "webhook_secret", secretRef: "JANUSLY_LOCAL_WEBHOOK_SECRET" },
  { name: "billing_slack", kind: "slack_webhook", secretRef: "JANUSLY_LOCAL_SLACK_WEBHOOK_URL" },
  { name: "ops_github", kind: "github_token", secretRef: "JANUSLY_LOCAL_GITHUB_TOKEN" },
  { name: "ops_slack", kind: "slack_webhook", secretRef: "JANUSLY_LOCAL_SLACK_WEBHOOK_URL" },
  { name: "support_slack", kind: "slack_webhook", secretRef: "JANUSLY_LOCAL_SLACK_WEBHOOK_URL" },
] as const;

async function seed(): Promise<void> {
  const existing = await db
    .select({ name: credentials.name, kind: credentials.kind, secretRef: credentials.secretRef, metadata: credentials.metadata })
    .from(credentials)
    .where(and(eq(credentials.orgId, orgId), inArray(credentials.name, desired.map((row) => row.name))));
  const byName = new Map(existing.map((row) => [row.name, row]));

  for (const row of desired) {
    const current = byName.get(row.name);
    if (current) {
      if (current.kind !== row.kind) {
        throw new Error(`local credential ${row.name} already exists with incompatible kind ${current.kind}`);
      }
      if (current.secretRef !== row.secretRef) {
        const source = current.metadata && typeof current.metadata === "object" && "source" in current.metadata
          ? current.metadata.source
          : null;
        if (source !== "local-stack") {
          throw new Error(`local credential ${row.name} already exists outside the local bootstrap`);
        }
        await db.update(credentials)
          .set({ secretRef: row.secretRef })
          .where(and(eq(credentials.orgId, orgId), eq(credentials.name, row.name)));
      }
      continue;
    }
    await db.insert(credentials).values({
      id: crypto.randomUUID(),
      orgId,
      ...row,
      metadata: { source: "local-stack" },
      createdBy: "local-stack",
    });
  }

  await upsertOrgConfig({
    orgId,
    key: "email.from",
    value: process.env.JANUSLY_MAILER_FROM ?? "janusly@example.test",
    userId: "local-stack",
  });
  await upsertOrgConfig({
    orgId,
    key: "email.provider",
    value: "simulator",
    userId: "local-stack",
  });

  console.log(`[seed-local-lab] ready org=${orgId} credentials=${desired.length}`);
}

seed()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[seed-local-lab] failed:", error);
    process.exit(1);
  });
