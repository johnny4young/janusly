/**
 * Tests that pin the shape and contract of every entry in the
 * `workflowTemplates` array. The route at `GET /templates` is a trivial
 * `sendJson(res, workflowTemplates)` proxy; what matters is that every
 * template parses cleanly through `WorkflowSchema` + `validateWorkflow`,
 * has a unique id, and — for templates that fire integration tools —
 * declares a `requiredCredentials` list that includes the matching kind.
 *
 * Templates are read-only metadata, immutable per release. A typo in a
 * tool name or a missing `requiredCredentials` entry surfaces here, not
 * silently at a customer's first run.
 */
import { describe, expect, it } from "vitest";
import { WorkflowSchema } from "@janusly/shared";
import { validateWorkflow } from "@janusly/engine/src/workflow-validation";
import { listTools } from "@janusly/engine/src/tool-registry";
import { listTemplatesContract, listToolsContract } from "./api-contracts";
import { asPublicTemplate, workflowTemplates } from "./templates";

/**
 * Mapping from a tool name to the credential `kind` that tool needs
 * stored in `credentials`. Sister to the per-tool kind constants in
 * `packages/engine/src/integration-tooling/`; updated together when a
 * new credential-bearing tool lands.
 */
const TOOL_TO_CREDENTIAL_KIND: Record<string, string> = {
  "slack.post": "slack_webhook",
  "github.create_issue": "github_token",
  "webhook.send": "webhook_secret",
};

const REGISTERED_TOOL_NAMES = new Set(listTools().map((t) => t.name));

describe("workflowTemplates — catalog shape", () => {
  it("keeps both public catalogs inside their stable wire contracts", () => {
    expect(listTemplatesContract.response.safeParse(
      workflowTemplates.map(asPublicTemplate),
    ).success).toBe(true);
    expect(listToolsContract.response.safeParse(listTools()).success).toBe(true);
  });

  it("every id is unique", () => {
    const ids = workflowTemplates.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every workflow parses cleanly through WorkflowSchema", () => {
    for (const template of workflowTemplates) {
      const parsed = WorkflowSchema.safeParse(template.workflow);
      if (!parsed.success) {
        throw new Error(`Template ${template.id} failed WorkflowSchema parse: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      }
    }
  });

  it("every workflow passes validateWorkflow with no issues", () => {
    for (const template of workflowTemplates) {
      const result = validateWorkflow(template.workflow);
      if (!result.valid) {
        throw new Error(`Template ${template.id} failed validateWorkflow: ${result.issues.map((i) => `[${i.code}] ${i.message}`).join("; ")}`);
      }
    }
  });

  it("requiredCredentials, when present, is a non-empty array of non-empty strings", () => {
    for (const template of workflowTemplates) {
      if (template.requiredCredentials === undefined) continue;
      expect(Array.isArray(template.requiredCredentials), `${template.id}.requiredCredentials must be an array`).toBe(true);
      for (const kind of template.requiredCredentials) {
        expect(typeof kind, `${template.id}: credential kind must be a string`).toBe("string");
        expect(kind.length, `${template.id}: credential kind cannot be empty`).toBeGreaterThan(0);
      }
    }
  });

  it("every `tool` node references a registered tool name", () => {
    for (const template of workflowTemplates) {
      for (const node of template.workflow.nodes) {
        if (node.type !== "tool") continue;
        const toolName = (node.config as { tool?: string })?.tool;
        expect(toolName, `${template.id}/${node.id}: tool config must declare a tool`).toBeTruthy();
        expect(REGISTERED_TOOL_NAMES.has(toolName!), `${template.id}/${node.id}: tool "${toolName}" is not in the registered catalog`).toBe(true);
      }
    }
  });

  it("`requiredCredentials` covers every credential-bearing tool the template fires", () => {
    for (const template of workflowTemplates) {
      const usedKinds = new Set<string>();
      for (const node of template.workflow.nodes) {
        if (node.type !== "tool") continue;
        const toolName = (node.config as { tool?: string })?.tool;
        if (!toolName) continue;
        const kind = TOOL_TO_CREDENTIAL_KIND[toolName];
        if (kind) usedKinds.add(kind);
      }

      const declared = new Set(template.requiredCredentials ?? []);
      for (const kind of usedKinds) {
        expect(declared.has(kind), `${template.id}: workflow uses a tool with kind "${kind}" but requiredCredentials does not include it`).toBe(true);
      }
    }
  });

  it("declared input schemas, when present, parse through the workflow input schema grammar", () => {
    // WorkflowSchema's `inputs` field already runs this check via the
    // top-level parse, but pinning it explicitly here makes the failure
    // message point at the right template.
    for (const template of workflowTemplates) {
      if (!template.workflow.inputs) continue;
      const parsed = WorkflowSchema.safeParse(template.workflow);
      expect(parsed.success, `${template.id}: workflow.inputs failed schema parse`).toBe(true);
    }
  });

  it("every node id is unique within its workflow", () => {
    for (const template of workflowTemplates) {
      const ids = template.workflow.nodes.map((n) => n.id);
      expect(new Set(ids).size, `${template.id}: duplicate node ids found`).toBe(ids.length);
    }
  });
});
