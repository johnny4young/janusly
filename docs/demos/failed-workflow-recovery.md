# Demo: Failed workflow recovery

**Template:** [`failed-workflow-recovery`](../../apps/api/src/templates.ts)
**Audience:** Every buyer. The wedge demo.
**Time:** 4-5 minutes
**Story:** "This is what makes Janusly different. The workflow breaks — twice, on purpose — and Janusly tells you what's wrong, suggests the fix, validates it in a sandbox, and shows exactly what has to be wired before a live replay. One demo, two recovery patterns, zero developer paged."

## Setup

| Need | How |
| --- | --- |
| No credentials | The template ships with `requiredCredentials: []`. The secret reference `{{secret.BILLING_API_KEY}}` is **intentionally unbound** — that is the failure we recover from. |
| Optional live-success endpoint | The checked-in URL is `https://billing.example.com/charges`. For a live green replay, change it in the Inspector to a reachable billing sandbox / RequestBin / local test endpoint and bind the replacement secret env-var before the final run. |
| No env tweaks | The demo runs in dev mode out of the box. For production-mode (`JANUSLY_PRODUCTION_MODE=true`), the readiness gate blocks `/start` until approval is added — which is itself the demo. |
| Sample payload | `{ "customer": "leah@example.com", "amountUsd": 49.00 }` |

## Run sequence (the full recovery loop)

**Phase 1 — the failure**

1. AI Studio → Templates → click **Failed workflow recovery → DLQ → patch → replay**. The 3-node DAG renders: `trigger` (webhook) → `charge` (http POST to billing.example.com) → `confirm_email`.
2. **Save** → **Run** with the sample payload.
3. The timeline runs `webhook.received`, then `charge` fires. The http node fails: the template-substitution sees `{{secret.BILLING_API_KEY}}` is unbound and the run lands `failed` on `charge`. The DLQ row carries `errorJson.message: "Missing secret: BILLING_API_KEY"`; failure clustering normalizes it as `Missing secret: BILLING_API_KEY`.
4. Recovery Queue surfaces the failed run with a red badge.

**Phase 2 — structural recovery (insert approval upstream)**

5. Click into the failed run → **Suggest fix**. The Recovery dialog opens.
6. The AI proposes two suggestions. The top suggestion is **structural**: "This http call is a write-side action (POST) with no approval gate upstream. Insert an `approval` node between `trigger` and `charge`."
7. Inspect the structural diff: the new approval node is added; the edge `trigger → charge` is rewired to `trigger → approval → charge`.
8. Click **Validate in sandbox**. A `replayMode: "validation"` run fires; the http POST is skipped (dryRun gate), the approval pauses; we approve in the sandbox, and the sandbox run terminates `succeeded`.
9. Click **Apply**. The patched workflow is saved as v2.

**Phase 3 — config recovery (swap_secret_ref)**

10. Re-run the v2 workflow. The new approval gate pauses; we approve.
11. The http node fires for real this time — and STILL fails, because the `{{secret.BILLING_API_KEY}}` is still unbound. DLQ row, second time.
12. Open the Recovery dialog again. This time the AI proposes a **config** suggestion: `swap_secret_ref` — bind the credential reference to a real env-var.
13. The dialog shows the structural diff: the `headers.Authorization` value changes from `"Bearer {{secret.BILLING_API_KEY}}"` to `"Bearer {{secret.BILLING_API_PROD_KEY}}"` (or whatever the operator's real secret is named).
14. Sandbox validation → green if the patched workflow no longer trips structural validation; apply → v3 saved.
15. For the live-success close, point the `charge` URL at a reachable billing sandbox and bind the replacement secret env-var. Re-run v3 with the sample payload. The approval pauses; we approve; the http POST fires successfully; the email confirmation sends. The run lands `succeeded`.

## Observability story

- **Run timeline** captures every failure end-to-end: the error envelope, the DLQ row id, the AI's suggested approach (`add_approval` then `swap_secret_ref`), the sandbox validation run, the patched-workflow save.
- **Recovery feedback loop** — when the operator clicks Apply, the system writes a `recovery.feedback` audit row with `approachLabel` + `accepted: true`. Future Recovery dialog calls for this workflow learn that `add_approval` and `swap_secret_ref` worked here, and prioritize them on similar failures.
- **Before/After delta** — once enough runs land against v3, the Recovery Center surfaces a delta card: "Health +12, p95 -3s, cost/run unchanged." Operators see the recovery's measurable impact.
- **Audit log** records every step: `ai.workflow.patch_suggested` (twice), `workflow.saved` (twice), `recovery.feedback` (twice), `recovery.validation_started` (twice).

## Human-in-the-loop story

The structural recovery IS the HITL upgrade — by inserting an approval node, the demo materializes the human gate that wasn't there before. The narrative beat: "Janusly didn't just fix the broken call; it taught the workflow to ASK before charging next time." This is the moment that lands with security and compliance buyers.

## Recovery story

This IS the recovery story. Two failures, two recovery patterns:

- **Structural** — the workflow's SHAPE is wrong (write-side action without approval). The Recovery dialog proposes a new node and rewires the edges. Sandbox validates the new shape before saving.
- **Config** — the workflow's CONFIG is wrong (secret reference unbound). The Recovery dialog proposes a value swap. Sandbox validates the new config before saving.

Both go through the SAME flow: review → sandbox → apply → replay. The sandbox is the safety net: nothing hits production until the operator has seen the validation run land green.

## Closing metric

**Time to verified recovery.** Read the actual production-only elapsed time from
the Recovery Center after the generation-bound replay succeeds. “30 minutes to
2 hours without Janusly” and “about 3 minutes with Janusly” are rehearsal
assumptions for the talk track, not measured customer or product evidence.

## 3-5 minute talk track

> **(0:00–0:30, the pitch)**
> Every automation platform tells you what failed. Janusly tells you what failed AND how to fix it AND lets you validate the fix in a sandbox before it touches production. Watch.
>
> **(0:30–1:30, the failure)**
> Here's a refund flow. Webhook in, billing call out, customer email. Looks fine — but it's broken in two ways on purpose. I run it. Watch the http node fail. The DLQ row lands in the Recovery Queue.
>
> **(1:30–2:30, structural recovery)**
> I click Suggest fix. The AI tells me what's actually wrong: "You're writing to billing without a human gate." It proposes inserting an approval node upstream. I see the diff — old DAG on the left, new DAG on the right. I click Validate in sandbox. The sandbox runs without touching the real billing system. Green. I Apply.
>
> **(2:30–3:30, config recovery)**
> Re-run. New approval pauses. I approve. http call fires — and fails again. This time the AI says "Your secret is unbound. Swap to one that's wired." Diff, sandbox, apply. For the live green finish, I point the placeholder billing URL at my sandbox endpoint and bind the replacement secret. Re-run. Approval pauses, I approve, billing call succeeds, customer email sends.
>
> **(3:30–4:30, the close)**
> Two failures, two recovery patterns, all reviewable, all replayable. Janusly records the production clock from detected failure to generation-bound verified recovery; compare that measured value with your own baseline. This is the Janusly difference: workflows that explain, recover, and safely evolve.
