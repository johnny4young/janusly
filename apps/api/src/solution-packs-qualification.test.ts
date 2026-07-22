/**
 * Cross-package qualification for the code-resident solution packs.
 *
 * Unlike the route tests, this file keeps the real engine validators active so
 * catalog drift cannot ship a sample that the runtime rejects or a pack whose
 * production readiness contains a fail-level issue.
 */

import { describe, expect, it } from "vitest";
import { listSolutionPacks } from "@janusly/solution-packs";
import { validateInputs } from "@janusly/engine/src/inputs-validator";
import { checkWorkflowReadiness } from "@janusly/engine/src/workflow-readiness";
import { validateWorkflow } from "@janusly/engine/src/workflow-validation";

describe("solution pack runtime qualification", () => {
  it("passes the real structural and production-readiness gates", () => {
    for (const pack of listSolutionPacks()) {
      const validation = validateWorkflow(pack.workflowJson, { strictToolInputs: true });
      expect(validation, `${pack.id}: structural validation`).toEqual({ valid: true, issues: [] });

      const readiness = checkWorkflowReadiness(pack.workflowJson);
      expect(
        readiness.issues.filter((issue) => issue.severity === "fail"),
        `${pack.id}: fail-level readiness`,
      ).toEqual([]);
    }
  });

  it("ships sample inputs accepted by each workflow's declared contract", () => {
    for (const pack of listSolutionPacks()) {
      expect(pack.workflowJson.inputs, `${pack.id}: inputs`).toBeDefined();
      for (const sample of pack.samplePayloads) {
        expect(
          validateInputs(pack.workflowJson.inputs!, sample.input),
          `${pack.id}:${sample.id}`,
        ).toEqual({ valid: true });
      }
    }
  });
});
