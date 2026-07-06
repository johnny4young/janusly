/**
 * End-to-end coverage for the RECOVERY LOOP — the product's wedge. The
 * demo-templates spec proves F3 lands in the DLQ; this drives the loop past
 * that: sandbox-validate a fix (reject a non-fix, accept a real one) and
 * replay the entry.
 *
 * Deterministic + provider-free: F3's `charge` node fails with
 * "Missing secret: BILLING_API_KEY" (a template-resolution error, NOT skipped
 * by the writes-skipped sandbox), so the sandbox gate can be exercised without
 * an AI key or network. The "real fix" replaces the failing http node with a
 * `noop` of the same id — it succeeds in BOTH the sandbox and a real production
 * replay (no network), so the replayed run genuinely recovers. (An auth-only
 * edit would pass the sandbox — which skips the write — but still fail a real
 * replay's http call; the noop fix avoids that so the test asserts a true
 * recovery, not a sandbox-only pass.)
 *
 * Driven via API requests (not the UI) so it stays well under the Playwright
 * per-test timeout.
 */

import { expect, test } from "@playwright/test";

import {
  deadLetterStatus,
  findDeadLetterForRun,
  loadTemplate,
  pollUntilTerminal,
  pollUntilWaitingOrTerminal,
  replayDeadLetter,
  resumeWebhook,
  startRun,
  validateFix,
} from "./_helpers/demo-helpers";

type WorkflowJson = { nodes: Array<{ id: string; type: string; config: Record<string, unknown> }> };

/** Deep-clone F3 and replace the failing `charge` http node with a `noop` of
 *  the same id — a real fix that succeeds in the sandbox AND a real replay. */
function fixChargeToNoop(workflow: WorkflowJson): WorkflowJson {
  const fixed = JSON.parse(JSON.stringify(workflow)) as WorkflowJson;
  const idx = fixed.nodes.findIndex((n) => n.id === "charge");
  if (idx >= 0) fixed.nodes[idx] = { id: "charge", type: "noop", config: {} };
  return fixed;
}

test.describe.configure({ mode: "serial" });

test.describe("Recovery loop", () => {
  test("fail → DLQ → sandbox rejects the non-fix, accepts a real fix → replay resolves the entry", async ({ request }) => {
    // 1. Run F3 to failure — `charge` throws "Missing secret" → DLQ.
    const workflow = (await loadTemplate(request, "failed-workflow-recovery")) as unknown as WorkflowJson;
    const payload = { customer: "leah@example.com", amountUsd: 49 };
    const { runId } = await startRun(request, workflow, payload);

    await pollUntilWaitingOrTerminal(request, runId, "trigger");
    await resumeWebhook(request, runId, "trigger", payload);

    const failed = await pollUntilTerminal(request, runId);
    expect(failed.status, "F3 is intentionally broken — the run must fail").toBe("failed");

    const dl = await findDeadLetterForRun(request, runId);
    expect(dl, "F3 must produce a DLQ entry").not.toBeNull();
    expect(dl!.nodeId, "the failing node is `charge`").toBe("charge");

    // 2. Sandbox REJECTS the still-broken workflow — the missing-secret template
    //    error is a read-side failure the writes-skipped sandbox still hits.
    const rejectRunId = await validateFix(request, dl!.id, workflow);
    const rejected = await pollUntilTerminal(request, rejectRunId);
    expect(rejected.status, "sandbox must REJECT a workflow whose failing node is unchanged").toBe("failed");
    expect(rejected.nodes.find((n) => n.nodeId === "charge")?.status).toBe("failed");

    // 3. Sandbox ACCEPTS the real fix (charge → noop) — the failing node now
    //    resolves, so the writes-skipped sandbox replay reaches succeeded.
    const fixed = fixChargeToNoop(workflow);
    const acceptRunId = await validateFix(request, dl!.id, fixed);
    const accepted = await pollUntilTerminal(request, acceptRunId);
    expect(accepted.status, "sandbox must ACCEPT a workflow whose failing node now resolves").toBe("succeeded");
    expect(accepted.nodes.find((n) => n.nodeId === "charge")?.status).toBe("succeeded");

    // 4. Replay AGAINST the fix — the DLQ entry resolves AND the run RECOVERS:
    //    the replay un-terminates the run + re-queues the failed node, then
    //    re-runs it against the applied fix. (Regression guard for the recovery
    //    bug where replay re-ran the original broken snapshot and stayed failed.)
    expect(await deadLetterStatus(request, dl!.id)).toBe("open");
    await replayDeadLetter(request, dl!.id, fixed);
    expect(await deadLetterStatus(request, dl!.id), "replay must flip the DLQ entry to replayed").toBe("replayed");

    const recovered = await pollUntilTerminal(request, runId);
    expect(recovered.status, "replaying against the applied fix must recover the run").toBe("succeeded");
    expect(recovered.nodes.find((n) => n.nodeId === "charge")?.status).toBe("succeeded");
  });
});
