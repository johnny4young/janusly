/**
 * Read-only proof that Supabase Auth and Janusly share one PostgreSQL database.
 *
 * Used by `local-stack.mjs verify-db`; `--expect-empty` additionally proves a
 * fresh manual-configuration handoff has no users, organizations, workflows,
 * credentials, or tenant configuration.
 */

import { client } from "@janusly/db";

const expectEmpty = process.argv.includes("--expect-empty");
const expectOnboarding = process.argv.includes("--expect-onboarding");

if (expectEmpty && expectOnboarding) {
  throw new Error("choose only one database expectation");
}

type TopologyRow = {
  database_name: string;
  auth_users_table: string | null;
  janusly_workflows_table: string | null;
};

type CountsRow = {
  auth_users: number;
  janusly_users: number;
  organizations: number;
  workflows: number;
  credentials: number;
  org_configs: number;
};

async function main(): Promise<void> {
  const [topology] = await client<TopologyRow[]>`
    SELECT
      current_database() AS database_name,
      to_regclass('auth.users')::text AS auth_users_table,
      to_regclass('public.workflows')::text AS janusly_workflows_table
  `;

  if (!topology?.auth_users_table || !topology.janusly_workflows_table) {
    throw new Error("unified database is missing auth.users or public.workflows");
  }

  let verifiedCounts: CountsRow | null = null;
  if (expectEmpty || expectOnboarding) {
    const [counts] = await client<CountsRow[]>`
      SELECT
        (SELECT count(*)::int FROM auth.users) AS auth_users,
        (SELECT count(*)::int FROM public.users) AS janusly_users,
        (SELECT count(*)::int FROM public.organizations) AS organizations,
        (SELECT count(*)::int FROM public.workflows) AS workflows,
        (SELECT count(*)::int FROM public.credentials) AS credentials,
        (SELECT count(*)::int FROM public.org_configs) AS org_configs
    `;
    const expected = expectEmpty
      ? {
          auth_users: 0,
          janusly_users: 0,
          organizations: 0,
          workflows: 0,
          credentials: 0,
          org_configs: 0,
        }
      : {
          auth_users: 1,
          janusly_users: 0,
          organizations: 0,
          workflows: 0,
          credentials: 0,
          org_configs: 0,
        };
    if (
      !counts
      || Object.entries(expected).some(([key, value]) => counts[key as keyof CountsRow] !== value)
    ) {
      throw new Error(
        `expected ${expectEmpty ? "an empty manual-start database" : "one onboarding identity without tenant data"}, received ${JSON.stringify(counts)}`,
      );
    }
    verifiedCounts = counts;
  }

  console.log(JSON.stringify({
    ok: true,
    database: topology.database_name,
    schemas: ["auth", "public"],
    empty: expectEmpty,
    onboarding: expectOnboarding,
    counts: verifiedCounts,
  }));
}

main()
  .then(() => client.end())
  .catch(async (error) => {
    console.error("[local-db-verify] failed:", error);
    await client.end();
    process.exit(1);
  });
