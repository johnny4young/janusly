import { client } from "@janusly/db";

const orgId = process.env.JANUSLY_LOCAL_ORG_ID?.trim() || "local-recovery-lab";

if (!orgId.startsWith("local-recovery-lab")) {
  throw new Error("cleanup-local-recovery-lab refuses to delete a non-lab organization");
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function cleanup(): Promise<void> {
  await client.begin(async (sql) => {
    await sql.unsafe(`
      CREATE TEMP TABLE janusly_lab_run_ids ON COMMIT DROP AS
      SELECT id FROM public.runs WHERE org_id = $1
    `, [orgId]);
    await sql.unsafe(`
      CREATE TEMP TABLE janusly_lab_workflow_ids ON COMMIT DROP AS
      SELECT id FROM public.workflows WHERE org_id = $1
    `, [orgId]);

    const runChildren = await sql`
      SELECT DISTINCT c.table_name
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.column_name = 'run_id'
        AND NOT EXISTS (
          SELECT 1
          FROM information_schema.columns org_column
          WHERE org_column.table_schema = c.table_schema
            AND org_column.table_name = c.table_name
            AND org_column.column_name = 'org_id'
        )
    `;
    for (const row of runChildren) {
      const tableName = String(row.table_name);
      await sql.unsafe(`
        DELETE FROM public.${quoteIdentifier(tableName)}
        WHERE run_id IN (SELECT id FROM janusly_lab_run_ids)
      `);
    }

    const workflowChildren = await sql`
      SELECT DISTINCT c.table_name
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.column_name = 'workflow_id'
        AND NOT EXISTS (
          SELECT 1
          FROM information_schema.columns org_column
          WHERE org_column.table_schema = c.table_schema
            AND org_column.table_name = c.table_name
            AND org_column.column_name = 'org_id'
        )
    `;
    for (const row of workflowChildren) {
      const tableName = String(row.table_name);
      await sql.unsafe(`
        DELETE FROM public.${quoteIdentifier(tableName)}
        WHERE workflow_id IN (SELECT id FROM janusly_lab_workflow_ids)
      `);
    }

    const orgTables = await sql`
      SELECT DISTINCT table_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'org_id'
    `;
    for (const row of orgTables) {
      const tableName = String(row.table_name);
      await sql.unsafe(
        `DELETE FROM public.${quoteIdentifier(tableName)} WHERE org_id = $1`,
        [orgId],
      );
    }
    await sql`DELETE FROM public.organizations WHERE id = ${orgId}`;
  });

  console.log(`[recovery-lab] removed persisted data for org=${orgId}`);
}

cleanup()
  .then(async () => {
    await client.end();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("[recovery-lab] cleanup failed:", error);
    await client.end().catch(() => undefined);
    process.exit(1);
  });
