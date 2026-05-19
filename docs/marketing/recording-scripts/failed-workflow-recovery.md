# Recording script — Failed workflow recovery (the headline)

**Source narrative:** [`docs/demos/failed-workflow-recovery.md`](../../demos/failed-workflow-recovery.md)
**Template:** [`failed-workflow-recovery`](../../../apps/api/src/templates.ts)
**Target length:** 4:30–5:30 (longer than the other two — covers two recovery patterns)
**Audience:** Every buyer. This is the wedge demo.
**Viewport:** 1440 × 900, 100% browser zoom
**Closing metric:** Mean Time To Recovery for failed automations (30–120 min → ~3 min)

## Pre-roll checklist

- [ ] `pnpm dev` running
- [ ] `pnpm seed:demos` has run at least once (this template has `requiredCredentials: []` — no credentials needed, but the seeder is the standard prep step regardless)
- [ ] **CRITICAL:** `BILLING_API_KEY` is NOT exported. The whole point of the first failure is that the template's `{{secret.BILLING_API_KEY}}` reference is unbound. If you export that exact env var before the first run, the missing-secret beat won't fire.
- [ ] Optional live-green close: if you want the final replay to really succeed on camera, prepare a reachable billing sandbox / RequestBin / local endpoint and a replacement secret env var such as `JANUSLY_DEMO_BILLING_API_KEY`; apply those edits only during the config-recovery beat.
- [ ] Web UI on fresh tab, 1440 × 900, no prior `failed-workflow-recovery` workflows in **Flows**
- [ ] Sample payload from [`assets/failed-workflow-recovery-payload.json`](assets/failed-workflow-recovery-payload.json) copied to clipboard
- [ ] Mic check, screen-recorder armed

## Setup commands

```bash
pnpm dev
pnpm seed:demos
# explicitly verify the demo secret is NOT set
unset BILLING_API_KEY
# optional live-green close, used later after the first two failures:
# export JANUSLY_DEMO_BILLING_API_KEY=<sandbox-token>
```

## Beat sheet

### 0:00–0:20 — Cold open (the pitch)

- **Visual:** **Home** Recovery Center, cursor neutral.
- **Voiceover:** "Every automation platform tells you what failed. Janusly tells you what failed, suggests how to fix it, and lets you validate the fix in a sandbox before it touches production. Let me show you."
- **Cue:** Slow, confident delivery. This is the highest-value sentence in the deck.

### 0:20–0:45 — Load the recipe

- **Visual:** Sidebar **Recipes** → locate **Failed workflow recovery → DLQ → patch → replay** → click → **Use recipe** (`rightPanel.templates.useRecipe`).
- **Voiceover:** "I'm picking the recovery demo. It's a three-node flow — webhook, billing call, email. Looks simple. But it's broken in two ways on purpose."
- **Cue:** Pause briefly so the viewer sees the three nodes on canvas.

### 0:45–1:15 — Save and trigger the broken flow

- **Visual:** Rename to "Failed workflow recovery — demo" → **Save**. Wait for "Saved version 1" toast. Click **Run** (`sidebar.action.run`). Paste payload:
  ```json
  {
    "customer": "leah@example.com",
    "amountUsd": 49.00
  }
  ```
  Click **Run** in the modal.
- **Voiceover:** "I trigger it. Webhook in. The billing call fires next."
- **Cue:** The run starts.

### 1:15–1:45 — The failure lands in the DLQ

- **Visual:** Switch to **Runs**. Click the run, click **Resume trigger**. Watch the timeline: `webhook.received` → `charge` lights up — then turns red. The run status flips to `failed`. Switch back to **Home** — the Recovery Queue tile now has a count of 1.
- **Voiceover:** "And there it goes. The billing call failed. The run lands in the DLQ. The Recovery Queue picks it up automatically."
- **Cue:** Let the red badge stay visible for a beat. This is the "things break" moment that primes the recovery payoff.

### 1:45–2:15 — Open the Recovery dialog

- **Visual:** Click the **Recovery Queue** tile to expand. The failed run row appears. Click **Suggest fix** (`dlq.action.suggest`) on the row. The Recovery dialog opens.
- **Voiceover:** "I click 'Suggest fix'. Janusly's AI is looking at the failed node, the workflow context, the error envelope, the historical patterns."
- **Cue:** Pause for the dialog to fully open.

### 2:15–2:55 — Structural recovery — insert an approval upstream

- **Visual:** The dialog shows two suggestions. The TOP suggestion is structural: "Insert an approval node upstream of the write-side billing call." Click **Generate suggestion** (`recoveryDialog.footer.generate`) if you haven't already. The diff view shows the original DAG on the left and the patched DAG (with a new `approval` node) on the right.
- **Voiceover:** "Top suggestion: this is a write-side call to billing without a human gate upstream. Janusly is recommending we add an approval node between the webhook and the charge. Not because the call FAILED — because it SHOULDN'T HAVE FIRED in the first place. This is the security-first beat."
- **Cue:** Highlight the new approval node in the diff with your cursor.

### 2:55–3:25 — Sandbox validation

- **Visual:** Click **Apply & validate** (`recoveryDialog.footer.applyValidate`). The dialog enters "Validating…" state. A sandbox run kicks off in the background. After ~5–10 seconds it reports success.
- **Voiceover:** "I click 'Apply and validate'. Janusly is running the patched workflow in a sandbox — fully isolated, no real billing call, no real email — to confirm the new shape works end to end. While that runs…"
- **Cue:** Use the validation wait to recap what the AI proposed. If validation takes longer than 10s, the post-production cut list trims it.

### 3:25–3:55 — Config recovery — swap the secret

- **Visual:** Sandbox validation passes. Click **Close** (`recoveryDialog.footer.close`). Re-run the v2 workflow. The new approval node pauses; approve. The charge node fires — and fails AGAIN because the secret is still unbound. Re-open the Recovery dialog from the new DLQ entry.
- **Voiceover:** "Now the approval is in place. Re-run. The human approves the charge — and the billing call still fails, because the secret was never bound. Janusly's second suggestion: swap the secret reference to a real credential. Different recovery class — this one's config, not structural."
- **Cue:** This is the "two patterns in one demo" payoff. Slow down.

### 3:55–4:30 — Validate the secret swap + replay

- **Visual:** Click **Generate suggestion** → see the swap diff (the Bearer token's secret name changes). For a live-green take, also edit the `charge` URL from `billing.example.com` to your reachable sandbox endpoint. Click **Apply & validate**. Sandbox passes. **Close**. Re-run the v3 workflow. Approve. The charge fires — succeeds only when both the replacement secret and reachable endpoint are wired. Email confirmation fires. Run lands `succeeded`.
- **Voiceover:** "Sandbox confirms the patched shape is safe. For the final live replay I wire the real sandbox endpoint and replacement secret, then replay — and we're back to green. Two failures, two recovery patterns, both reviewable, both replayable, no operator paged."
- **Cue:** Hold the green `succeeded` status for 2 seconds.

### 4:30–5:00 — Close on the wedge metric

- **Visual:** Back to **Home**. Hover the **MTTR** card.
- **Voiceover:** "Without Janusly: discover the failure, file a ticket, page someone to fix the secret, redeploy, retry. Thirty minutes to two hours. With Janusly: three minutes, one operator, no redeploy, audit-clean. This is the Janusly difference — workflows that explain, recover, and safely evolve."
- **Cue:** Confident close. This is the line that sells.

### 5:00–5:15 — Outro card

- **Visual:** Logo + tagline. Optional: overlay the metric callout "Mean Time To Recovery: ~3 minutes."
- **Voiceover:** (optional) "Janusly — explain, recover, evolve."

## Cut list (post-production)

- 1:45–1:55: trim Recovery dialog open animation if it lingers past 1 second
- 2:55–3:25: trim sandbox validation wait time (the script narrates into the wait; if VO ran out you can speed-ramp the spinner)
- 3:55–4:10: trim second-sandbox wait similarly

## Asset references

- Webhook payload: [`assets/failed-workflow-recovery-payload.json`](assets/failed-workflow-recovery-payload.json)
- Narrative source: [`docs/demos/failed-workflow-recovery.md`](../../demos/failed-workflow-recovery.md)
- Template definition: [`apps/api/src/templates.ts`](../../../apps/api/src/templates.ts) (search `failed-workflow-recovery`)
- e2e regression: [`apps/web/e2e/demo-templates.spec.ts`](../../../apps/web/e2e/demo-templates.spec.ts) ("F3 failed-workflow-recovery")
