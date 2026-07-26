/**
 * Read-only proof that Supabase Auth and Janusly share one PostgreSQL database.
 *
 * Used by `local-stack.mjs verify-db`; `--expect-empty` additionally proves a
 * fresh manual-configuration handoff has no users, organizations, workflows,
 * credentials, or tenant configuration.
 */

import { client } from "@janusly/db";

const expectEmpty = process.argv.includes("--expect-empty");

type TopologyRow = {
  database_name: string;
  auth_users_table: string | null;
  janusly_workflows_table: string | null;
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

  if (expectEmpty) {
    type CountsRow = {
      auth_users: number;
      janusly_users: number;
      organizations: number;
      workflows: number;
      credentials: number;
      org_configs: number;
    };
    const [counts] = await client<CountsRow[]>`
      SELECT
        (SELECT count(*)::int FROM auth.users) AS auth_users,
        (SELECT count(*)::int FROM public.users) AS janusly_users,
        (SELECT count(*)::int FROM public.organizations) AS organizations,
        (SELECT count(*)::int FROM public.workflows) AS workflows,
        (SELECT count(*)::int FROM public.credentials) AS credentials,
        (SELECT count(*)::int FROM public.org_configs) AS org_configs
    `;
    if (!counts || Object.values(counts).some((count) => count !== 0)) {
      throw new Error(`expected an empty manual-start database, received ${JSON.stringify(counts)}`);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    database: topology.database_name,
    schemas: ["auth", "public"],
    empty: expectEmpty,
  }));
}

main()
  .then(() => client.end())
  .catch(async (error) => {
    console.error("[local-db-verify] failed:", error);
    await client.end();
    process.exit(1);
  });
