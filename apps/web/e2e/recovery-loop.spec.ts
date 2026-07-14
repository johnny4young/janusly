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
const API_URL = process.env.E2E_API_URL ?? "http://localhost:3001";
const AUTH = { "x-org-id": "default", "x-user-id": "dev-user" };
const OTHER_AUTH = { "x-org-id": "recovery-loop-other", "x-user-id": "other-user" };

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
    const ledgerBefore = await request.get(`${API_URL}/recovery/ledger`, { headers: AUTH });
    const winsBefore = await request.get(`${API_URL}/recovery/my-wins?days=30`, { headers: AUTH });
    const otherLedgerBefore = await request.get(`${API_URL}/recovery/ledger`, { headers: OTHER_AUTH });
    expect(ledgerBefore.ok()).toBe(true);
    expect(winsBefore.ok()).toBe(true);
    expect(otherLedgerBefore.ok()).toBe(true);
    const ledgerBaseline = await ledgerBefore.json() as { totalRecovered: number };
    const winsBaseline = await winsBefore.json() as { recovered: number };
    const otherLedgerBaseline = await otherLedgerBefore.json() as { totalRecovered: number };

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

    // 5. The SAME real replay must atomically materialize lifetime impact,
    // personal operator momentum, and incident closure — with no cross-tenant
    // leakage. This intentionally does not seed recovery-impact tables.
    const ledgerAfter = await request.get(`${API_URL}/recovery/ledger`, { headers: AUTH });
    const winsAfter = await request.get(`${API_URL}/recovery/my-wins?days=30`, { headers: AUTH });
    const itemsAfter = await request.get(`${API_URL}/recovery/items?limit=200`, { headers: AUTH });
    const otherLedgerAfter = await request.get(`${API_URL}/recovery/ledger`, { headers: OTHER_AUTH });
    expect(ledgerAfter.ok()).toBe(true);
    expect(winsAfter.ok()).toBe(true);
    expect(itemsAfter.ok()).toBe(true);
    expect(otherLedgerAfter.ok()).toBe(true);

    // These are organization/operator rollups, so another parallel E2E using
    // the shared dev tenant may legitimately add a recovery after our
    // baseline read. The linked incident assertion below proves this replay's
    // own terminal effect; the rollups must advance by at least one.
    expect((await ledgerAfter.json() as { totalRecovered: number }).totalRecovered)
      .toBeGreaterThanOrEqual(ledgerBaseline.totalRecovered + 1);
    const winsAfterPayload = await winsAfter.json() as { recovered: number; windowDays: number };
    expect(winsAfterPayload.recovered).toBeGreaterThanOrEqual(winsBaseline.recovered + 1);
    expect(winsAfterPayload.windowDays).toBe(30);
    const recoveryItems = await itemsAfter.json() as {
      items: Array<{ id: string; deadLetterId: string; status: string; resolutionReason: string | null }>;
    };
    let linkedItem = recoveryItems.items.find((item) => item.deadLetterId === dl!.id);
    if (!linkedItem) {
      for (const item of recoveryItems.items) {
        const childrenResponse = await request.get(
          `${API_URL}/recovery/items/${encodeURIComponent(item.id)}/children`,
          { headers: AUTH },
        );
        if (!childrenResponse.ok()) continue;
        const payload = await childrenResponse.json() as {
          children: Array<{ deadLetterId: string }>;
        };
        if (payload.children.some((child) => child.deadLetterId === dl!.id)) {
          linkedItem = item;
          break;
        }
      }
    }
    expect(linkedItem).toMatchObject({
      status: "resolved",
      resolutionReason: "sandbox_replay_succeeded",
    });
    expect(await otherLedgerAfter.json()).toMatchObject({
      totalRecovered: otherLedgerBaseline.totalRecovered,
    });
  });
});
