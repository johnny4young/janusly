/** Human and external waiting checkpoint executors. */

import { getOrgConfigSnapshot } from "@janusly/data";
import { WorkflowInputSchema } from "@janusly/shared";

import { approvalExecutor } from "../approval-timeout";
import { validateInputs } from "../inputs-validator";
import { signResumeToken } from "../secrets";
import type { NodeExecutorMap } from "./types";

export const waitingNodeExecutors = {
  // `webhook` / `approval` keep the legacy checkpoint-coordinate token:
  // the authenticated `/resume` route still gates the action, and the token
  // mostly lets the UI/API point at the waiting node. `human_form` below uses
  // an HMAC-signed token because form links can leave the app context and
  // carry user-submitted data that becomes node output.
  webhook: async (ctx) => ({
    status: "waiting",
    reason: "Waiting for external webhook resume",
    metadata: { kind: "webhook", resumeToken: `${ctx.runId}:${ctx.nodeId}` },
  }),
  approval: approvalExecutor,
  human_form: async (ctx) => {
    const schema = WorkflowInputSchema.parse(ctx.config.schema);
    const initialValues = ctx.config.initialValues;
    if (initialValues !== undefined) {
      const validation = validateInputs(schema, initialValues);
      if (!validation.valid) {
        throw new Error(`human_form.initialValues invalid: ${validation.errors.join("; ")}`);
      }
    }
    const orgConfig = await getOrgConfigSnapshot(ctx.orgId);
    const title = typeof ctx.config.title === "string" && ctx.config.title.trim()
      ? ctx.config.title.trim()
      : "Human input required";
    const description = typeof ctx.config.description === "string" && ctx.config.description.trim()
      ? ctx.config.description.trim()
      : undefined;
    return {
      status: "waiting",
      reason: "Waiting for form submission",
      metadata: {
        kind: "human_form",
        title,
        description,
        schema,
        ...(initialValues !== undefined ? { initialValues } : {}),
        resumeToken: signResumeToken(
          { orgId: ctx.orgId, runId: ctx.runId, nodeId: ctx.nodeId, purpose: "human_form" },
          { ttlSeconds: orgConfig.runs.humanFormResumeTtlSeconds },
        ),
      },
    };
  },
  noop: async () => ({ status: "completed" }),
} satisfies Pick<NodeExecutorMap, "webhook" | "approval" | "human_form" | "noop">;
