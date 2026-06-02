# Recording scripts — flagship Janusly demos

Recording-ready scripts for the three flagship demos. Each script extends the narrative in [`docs/demos/`](../../demos/) into a second-by-second timed beat sheet with exact button labels, copy-pasteable setup commands, and explicit failure-injection / recovery sequences.

The narratives in `docs/demos/` are the story; the scripts here are how you film it.

## Scripts in this directory

| Script | Target length | Audience | Source narrative |
| --- | --- | --- | --- |
| [`incident-triage.md`](incident-triage.md) | 4:00–5:00 | SRE / on-call / ops engineering | [`docs/demos/incident-triage.md`](../../demos/incident-triage.md) |
| [`refund-triage.md`](refund-triage.md) | 4:00–5:00 | Revenue ops / finance ops | [`docs/demos/refund-triage.md`](../../demos/refund-triage.md) |
| [`failed-workflow-recovery.md`](failed-workflow-recovery.md) | 4:30–5:30 (the headline) | Every buyer | [`docs/demos/failed-workflow-recovery.md`](../../demos/failed-workflow-recovery.md) |

The headline runs longer because it covers BOTH recovery patterns (structural insert-approval + config swap_secret_ref) sequentially.

## Sample payloads

The `assets/` directory carries the JSON payloads the presenter pastes into the webhook trigger during recording. Identical to the payloads `apps/web/e2e/demo-templates.spec.ts` uses — so if the e2e is green, the recording will work.

| File | Used by |
| --- | --- |
| [`assets/incident-triage-payload.json`](assets/incident-triage-payload.json) | `incident-triage.md` |
| [`assets/refund-triage-payload.json`](assets/refund-triage-payload.json) | `refund-triage.md` |
| [`assets/failed-workflow-recovery-payload.json`](assets/failed-workflow-recovery-payload.json) | `failed-workflow-recovery.md` |

## Pre-recording prerequisites (one-time setup)

Run these once per machine before your first recording. They are not per-recording — the same setup works for any of the three scripts.

1. **Node, pnpm, Docker** — match the versions pinned in the repo (Node 24, pnpm 10.23.0). The `pnpm dev` script handles the rest.
2. **Clone + install:**
   ```bash
   git clone <repo>
   cd janusly
   pnpm install
   ```
3. **Bring the dev stack up:**
   ```bash
   pnpm dev
   ```
   This brings Compose up (Postgres + Redis + Ollama), applies migrations, and spawns api + worker + web. The web lands at <http://localhost:5173>; api at <http://localhost:3001>.

4. **Seed the demo credentials:**
   ```bash
   pnpm seed:demos
   ```
   Idempotent — re-runs are no-ops by default. Pass `--force` if you ever need to reset (e.g., after rotating an env-var name). Writes exactly three credential rows: `bot-github` (`github_token` → env `JANUSLY_DEMO_GITHUB_TOKEN`), `incidents-slack` (`slack_webhook` → env `JANUSLY_DEMO_SLACK_WEBHOOK`), `partner-webhook` (`webhook_secret` → env `JANUSLY_DEMO_WEBHOOK_SECRET`).

   The env-vars themselves can stay unset for the recording — the demos surface the `ok: false` envelope from the integration tools without requiring real GitHub / Slack / billing endpoints. Setting them only matters if you want the real outbound HTTP to happen on camera.

5. **Open the web UI in a fresh browser profile.** The demo always looks better without your half-dozen browser extensions interfering. Set zoom to 100% and viewport to 1440×900 (Chrome devtools → Device toolbar → Responsive → 1440×900) so the layout matches the typical landing-page screenshot crop.

## Global timing conventions

Every beat is stamped `MM:SS–MM:SS`. Beats are roughly 15–30 seconds. The structure inside a beat:

- **Visual** — what the presenter does on screen (exact button label in **bold**).
- **Voiceover** — the literal sentence the presenter says.
- **Cue** — presenter hint (when to wait for a spinner, when to let the timeline settle, etc.).

The total of all beats lands within the target run length. If a take overshoots, the natural cut points are between beats, not inside.

## Failure injection

Each script's recovery beat is anchored on a specific "broken thing." The script tells you exactly which knob to turn off:

- **`incident-triage`** — narrate the recovery angle (no on-camera break; Slack credentials are deliberately invalid for the recording so the tool envelopes return `ok: false` while the workflow still terminates green).
- **`refund-triage`** — narrate the recovery angle (billing webhook URL points at a placeholder host; no on-camera break needed beyond explaining what would happen on a real 401).
- **`failed-workflow-recovery`** — the workflow IS broken by design. No injection needed; just run it.

## Post-production checklist

After the take is in the can:

1. **Volume normalize** to –14 LUFS (broadcast standard for VO-only content).
2. **Trim wait time** at the cut points each script flags (the script's "Cut list" section).
3. **Intro + outro card** — Janusly logo + "Janusly — AI workflows that explain, recover, and safely evolve." Hold for 1.5s.
4. **Captions** — auto-generate, then proofread. Captions improve LinkedIn watch-through ~3x.
5. **Closing metric callout** — overlay a card with "Mean Time To Recovery: <X seconds>" during the closing beat.
6. **Export** at 1080p, MP4 H.264, ~6 Mbps bitrate.

## What to do if a button label changed

The scripts cite both the literal English label AND the i18n key (e.g., **Use recipe** / `rightPanel.templates.useRecipe`). If a future ticket renames the English label, grep the i18n key across `apps/web/src/i18n/locales/` to find the new label and patch the script. The narrative docs in `docs/demos/` use the same labels and the e2e spec asserts behavior, not text, so a label rename is the only churn vector here.
