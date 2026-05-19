# Recording script — Refund triage

**Source narrative:** [`docs/demos/refund-triage.md`](../../demos/refund-triage.md)
**Template:** [`refund-triage-approval`](../../../apps/api/src/templates.ts)
**Target length:** 4:00–5:00
**Audience:** Revenue ops / finance ops / customer-support team leads
**Viewport:** 1440 × 900, 100% browser zoom
**Closing metric:** Approvals processed per operator hour (8–15 min → 30 sec)

## Pre-roll checklist

- [ ] `pnpm dev` running (api, worker, web up)
- [ ] `pnpm seed:demos` has been run at least once (the `partner-webhook` credential must exist)
- [ ] Web UI open at <http://localhost:5173>, fresh tab, no prior **Refund triage** workflows in **Flows**
- [ ] Browser viewport 1440 × 900, zoom 100%
- [ ] Sample payload from [`assets/refund-triage-payload.json`](assets/refund-triage-payload.json) copied to clipboard
- [ ] Mic check, screen-recorder armed
- [ ] **DO NOT** export `JANUSLY_DEMO_WEBHOOK_SECRET` for the recording — we want the signed webhook to surface `ok: false` from the placeholder billing URL so the audit + signature beat is visible without firing real outbound calls

## Setup commands

```bash
pnpm dev            # if not already running
pnpm seed:demos     # idempotent
```

## Beat sheet

### 0:00–0:15 — Cold open

- **Visual:** Web UI on the **Home** Recovery Center, cursor neutral.
- **Voiceover:** "Refunds are the perfect Janusly use case. A human should make the call — but everything around the call is paperwork the human shouldn't do."
- **Cue:** Hold the Recovery Center view briefly; the "Pending approvals" tile primes the upcoming HITL beat.

### 0:15–0:45 — Load the recipe

- **Visual:** Click sidebar **Recipes** → locate the **Refund triage → approval → billing webhook** card → click **Use recipe** (`rightPanel.templates.useRecipe`).
- **Voiceover:** "I'm picking refund triage. Five-node flow: webhook receives the ticket, AI summarizes the claim, human approves, signed webhook fires the billing system, customer gets an email."
- **Cue:** Wait for the canvas to render all five nodes including the prominent **human_review** approval node.

### 0:45–1:15 — Save and trigger

- **Visual:** Rename to "Refund triage — demo". Click **Save** (`sidebar.action.save`). Wait for the "Saved version 1" toast. Click **Run** (`sidebar.action.run`). In the modal, paste the payload:
  ```json
  {
    "customer": "leah@example.com",
    "orderId": "ord_8421",
    "amountUsd": 49.00,
    "reason": "Charged twice for the same order"
  }
  ```
  Click **Run** in the modal.
- **Voiceover:** "Real customer email, real order id, the reason in their own words. I trigger the workflow."
- **Cue:** The run starts.

### 1:15–1:45 — Webhook resume + AI analysis

- **Visual:** Switch to **Runs** → click the new run → click **Resume trigger**. The timeline animates: `webhook.received` → `ai.completed`. Click the `analyze` node card to expand the AI's claim summary.
- **Voiceover:** "Webhook releases. AI immediately reads the claim — note it picks out the words 'charged twice' and flags this as a likely billing-error case rather than a fraud-pattern."
- **Cue:** Highlight a specific phrase from the AI output that demonstrates contextual reading.

### 1:45–2:30 — The approval beat (the headline)

- **Visual:** The run goes `waiting` on `human_review`. The Recovery Center → **Pending approvals** tile gets a new row. Click **Resume human_review** (or click the tile and approve from there).
- **Voiceover:** "And here's the headline. The run paused. A human approves. Not just a yes-or-no button — they see the AI's summary, the dollar amount, the customer email, all in one screen. They decide in thirty seconds instead of fifteen minutes."
- **Cue:** Pause at the approval prompt for 2 full seconds so the viewer reads the templated message ("Approve refund of $49.00 for leah@example.com (order ord_8421)?"). Then click approve.

### 2:30–3:15 — Signed webhook + audit

- **Visual:** The timeline resumes. `process_refund` fires — the signed POST goes out. Click the node card to show the request headers. Point at the `X-Janusly-Signature` header value (or `x-janusly-signature`).
- **Voiceover:** "When the human approves, the run resumes. The signed webhook hits the billing system. HMAC-SHA-256 over timestamp dot body — five lines on the receiving side, zero vendor SDK on ours. Your security team will ask for this header by name."
- **Cue:** Pause on the signature header; let it be readable.

### 3:15–3:45 — Output envelope + audit row

- **Visual:** The `process_refund` envelope shows `{ ok: false, statusCode, error }` because the URL is a placeholder. The downstream `confirm_email` still runs. Click the **Audit** sub-tab and point at `run.resumed` with the operator's user id.
- **Voiceover:** "The billing endpoint isn't bound in this demo — the envelope says `ok: false`. But the audit log captured everything: who approved, when, and what the resulting webhook attempt returned. Non-repudiable. Year-end-close-friendly."
- **Cue:** Don't apologize for the `ok: false` — frame it as "this is what the audit captures even when things fail."

### 3:45–4:30 — The recovery angle

- **Visual:** Back to **Home**. Point at the (still mostly empty) Recovery Queue tile.
- **Voiceover:** "If billing 401's us — wrong credential, expired token, mismatched signing secret — the failed run lands in the Recovery Queue. Janusly's AI suggests swapping the credential, you validate in a sandbox, you replay. The customer email never fires for a failed refund."
- **Cue:** This is the lead-in to the failed-workflow-recovery demo if you're cutting this into a sequence.

### 4:30–4:50 — Close on the metric

- **Visual:** Hover the **MTTR** or **Pending approvals** card in the metric strip.
- **Voiceover:** "One human decision in thirty seconds. Everything else automated, signed outbound, fully audited, self-healing when billing has a bad day. The number we track is approvals per operator hour — and this demo just multiplied that."
- **Cue:** Hold the frame.

### 4:50–5:00 — Outro card

- **Visual:** Outro card with logo + tagline.
- **Voiceover:** (optional) "Janusly — explain, recover, evolve."

## Cut list (post-production)

- 1:15–1:25: trim Runs-tab navigation latency
- 1:45–1:55: trim the small delay between Run-resumed and the approval prompt appearing
- 3:15–3:25: trim the timeline animation if the `confirm_email` step takes more than 1 second

## Asset references

- Webhook payload: [`assets/refund-triage-payload.json`](assets/refund-triage-payload.json)
- Narrative source: [`docs/demos/refund-triage.md`](../../demos/refund-triage.md)
- Template definition: [`apps/api/src/templates.ts`](../../../apps/api/src/templates.ts) (search `refund-triage-approval`)
- e2e regression: [`apps/web/e2e/demo-templates.spec.ts`](../../../apps/web/e2e/demo-templates.spec.ts) ("F2 refund-triage-approval")
