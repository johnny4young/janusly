# Recording script — Incident triage

**Source narrative:** [`docs/demos/incident-triage.md`](../../demos/incident-triage.md)
**Template:** [`incident-triage`](../../../apps/api/src/templates.ts)
**Target length:** 4:00–5:00
**Audience:** SRE / on-call engineering managers / operations leads
**Viewport:** 1440 × 900, 100% browser zoom
**Closing metric:** Mean Time To Recovery for failed Slack pings (minutes → seconds)

## Pre-roll checklist

- [ ] `pnpm dev` running (api, worker, web up)
- [ ] `pnpm seed:demos` has been run at least once
- [ ] Web UI open at <http://localhost:5173>, fresh tab, no other workflows visible in **Flows**
- [ ] Browser viewport 1440 × 900, zoom 100%
- [ ] Sample payload from [`assets/incident-triage-payload.json`](assets/incident-triage-payload.json) copied to clipboard
- [ ] Mic check, screen-recorder armed, OBS / Loom / Riverside scene confirmed
- [ ] **DO NOT** export `JANUSLY_DEMO_GITHUB_TOKEN` / `JANUSLY_DEMO_SLACK_WEBHOOK` for the recording — we want the tool envelopes to surface `ok: false` so the audit trail is visible without firing real outbound calls

## Setup commands (one-time, before pressing record)

```bash
pnpm dev            # if not already running
pnpm seed:demos     # idempotent — no-op when credentials already exist
```

If the dev DB has any prior workflows from earlier rehearsals, delete them via **Flows → ⋯ → Delete** so the recording starts with a clean Workflows panel.

## Beat sheet

### 0:00–0:15 — Cold open

- **Visual:** Web UI on the **Home** (Recovery Center) tab. Cursor neutral over the metric strip.
- **Voiceover:** "When PagerDuty wakes someone up at two a.m., the worst part isn't the alert. It's the next ten minutes of paperwork — file the ticket, find the channel, page the on-call. Today I'll show you Janusly do that paperwork for you."
- **Cue:** Hold the Recovery Center view for half a beat — the green metric strip and the empty Recovery Queue tile sell the "we operate workflows" framing.

### 0:15–0:45 — Load the recipe

- **Visual:** Click sidebar **Recipes** (`sidebar.nav.templates.label`). The Recipes panel opens. Scroll / locate the **Incident triage → GitHub + Slack** card. Click it. Click the **Use recipe** button (`rightPanel.templates.useRecipe`) in the panel footer.
- **Voiceover:** "Janusly ships with a recipe catalog. I'm picking Incident triage — it's a four-node flow: webhook in, AI summarize, GitHub issue, Slack notify."
- **Cue:** Wait for the canvas to paint all four nodes (~1 second). Pause for half a beat once they're visible so the viewer registers the DAG shape.

### 0:45–1:15 — Save the workflow

- **Visual:** Edit the workflow name field at the top to "Incident triage — demo". Click **Save** (`sidebar.action.save`) in the sidebar.
- **Voiceover:** "I save the recipe as my own workflow. From here it's editable — I could swap the GitHub repo, change the Slack channel, add a condition — but for today the defaults are fine."
- **Cue:** Wait for the toast "Saved version 1" before continuing.

### 1:15–1:55 — Trigger the run

- **Visual:** Click **Run** (`sidebar.action.run`). A modal asks for the trigger input. Paste the payload from [`assets/incident-triage-payload.json`](assets/incident-triage-payload.json):
  ```json
  {
    "alertName": "API p95 above 800ms",
    "service": "checkout-api",
    "severity": "high"
  }
  ```
  Click **Run** in the modal.
- **Voiceover:** "I'm pasting the alert payload — exactly what PagerDuty would send. Webhook receives it, the run starts."
- **Cue:** The run kicks off; the **trigger** node lights up.

### 1:55–2:30 — Resume the webhook + watch the timeline

- **Visual:** Switch to the **Runs** tab (`sidebar.nav.runs.label`). The new run appears at the top. Click the row, then click **Resume trigger** (`rightPanel.runs.resume`) — that's the webhook releasing with the payload as its output.
- **Voiceover:** "Webhook nodes pause until something releases them — usually that's PagerDuty itself in production. Here I'm releasing it manually so we can watch the rest of the chain run."
- **Cue:** The timeline animates: `webhook.received` → `ai.completed` → `tool.completed` × 2. The AI summary is visible inline in the `summarize` node card.

### 2:30–3:00 — Read the AI summary aloud

- **Visual:** Click the `summarize` node card to expand it. The AI's two-sentence incident summary fills the inspector panel.
- **Voiceover:** "AI just wrote the issue body. Not boilerplate — it actually read the payload and called out the affected service and severity. This is what makes the GitHub ticket useful instead of noise."
- **Cue:** Highlight one specific phrase from the summary on screen with your cursor.

### 3:00–3:30 — Observability + audit

- **Visual:** Click the `slack_notify` node. The output envelope shows `{ ok: false, statusCode, error }` because we deliberately didn't bind the real Slack webhook URL — but the run still reached `succeeded`. Open the **Audit** sub-tab (or expand the run timeline footer) to show `tool.executed × 2`.
- **Voiceover:** "Look at this — the Slack credential wasn't set, so the tool envelope says `ok: false`. The workflow didn't crash; it captured the failure and moved on. Your audit log gets one row per integration call, every time. Compliance loves this."
- **Cue:** Don't dwell on the `ok: false` — frame it as "this is what graceful failure looks like."

### 3:30–4:15 — The recovery angle (narration, no on-camera break)

- **Visual:** Back to the **Home** Recovery Center. Point at the Recovery Queue tile (currently empty for this run because the workflow succeeded).
- **Voiceover:** "Now imagine Slack rate-limits us mid-incident. The flow still runs. The failed Slack post lands in the Recovery Queue. The operator opens a recovery dialog, AI suggests adding a retry policy or swapping the credential, validates the fix in a sandbox, and replays. From Slack-is-down to Slack-is-fixed — under a minute, no operator paged twice. We'll show that loop in the next demo."
- **Cue:** Slow down here. This is the bridge to the next demo.

### 4:15–4:45 — Close on the metric

- **Visual:** Hover the **MTTR** card in the Recovery Center metric strip.
- **Voiceover:** "Three integrations, one flow, the audit trail your security team wants, and a recovery story your on-call team will love. The number we track for you is Mean Time To Recovery — and we just took ours from minutes to seconds."
- **Cue:** Hold this frame for 2 seconds before fade-out so the metric card stays in the freeze frame for the YouTube thumbnail.

### 4:45–5:00 — Outro card

- **Visual:** Cut to outro card: Janusly logo, tagline "AI workflows that explain, recover, and safely evolve."
- **Voiceover:** (optional) "Janusly — explain, recover, evolve."
- **Cue:** 1.5 second hold.

## Cut list (post-production)

- 0:45–0:50: trim canvas-paint animation if it lingers past 1 second
- 1:55–2:00: trim Runs-tab navigation if it has any noticeable delay
- 2:30–2:40: trim AI summary fade-in to a snappier appearance

## Asset references

- Webhook payload: [`assets/incident-triage-payload.json`](assets/incident-triage-payload.json)
- Narrative source: [`docs/demos/incident-triage.md`](../../demos/incident-triage.md)
- Template definition: [`apps/api/src/templates.ts`](../../../apps/api/src/templates.ts) (search `incident-triage`)
- e2e regression: [`apps/web/e2e/demo-templates.spec.ts`](../../../apps/web/e2e/demo-templates.spec.ts) ("F1 incident-triage")
