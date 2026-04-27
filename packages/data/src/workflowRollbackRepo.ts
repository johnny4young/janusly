import { db, workflowVersions } from "@janusly/db";
import { and, desc, eq } from "drizzle-orm";

export async function rollbackWorkflowVersion(input: {
  orgId: string;
  workflowId: string;
  targetVersion: number;
  createdBy?: string;
  reason?: string;
}) {
  const versions = await db
    .select()
    .from(workflowVersions)
    .where(and(eq(workflowVersions.orgId, input.orgId), eq(workflowVersions.workflowId, input.workflowId)))
    .orderBy(desc(workflowVersions.version));

  const latest = versions[0];
  const target = versions.find((version) => version.version === input.targetVersion);

  if (!latest) throw new Error("Workflow has no versions to rollback from");
  if (!target) throw new Error(`Target workflow version ${input.targetVersion} not found`);

  const nextVersion = (latest.version ?? 0) + 1;
  const versionId = crypto.randomUUID();

  await db.insert(workflowVersions).values({
    id: versionId,
    orgId: input.orgId,
    workflowId: input.workflowId,
    version: nextVersion,
    dagJson: {
      ...(target.dagJson as Record<string, unknown>),
      id: input.workflowId,
      metadata: {
        ...((target.dagJson as any)?.metadata ?? {}),
        rollback: {
          fromVersion: latest.version,
          toVersion: target.version,
          reason: input.reason ?? "automatic rollback",
        },
      },
    },
    createdBy: input.createdBy,
  });

  return {
    workflowId: input.workflowId,
    versionId,
    previousVersion: latest.version,
    restoredVersion: target.version,
    newVersion: nextVersion,
  };
}
