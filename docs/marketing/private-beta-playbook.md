# Janusly private-beta playbook

The operational handbook for the private-beta MTTR experiment. Open this tab the moment you start recruiting design partners — every instrument inside (intake form, baseline survey, kickoff script, weekly-report template, willingness-to-pay conversation, exit interview, report skeleton) is copy-pasteable. The founder runs the experiment from this doc without inventing copy mid-flight.

**Strategy lives in [`docs/PLAN.md` §16.0](../PLAN.md).** **Brand voice in [`docs/marketing/narrative.md`](narrative.md).** **Segment definitions in [`docs/marketing/icp.md`](icp.md).** **Pricing release plan in [`docs/marketing/pricing.md`](pricing.md) Section G.** **Buying triggers (qualification heuristics) in [`docs/marketing/competitive-positioning.md`](competitive-positioning.md) Section E.** **Demo recording scripts under [`docs/marketing/recording-scripts/`](recording-scripts/).** This doc consumes all six and is the **instruments layer** — every survey, every script, every form the experiment uses.

**What this doc is NOT.** It is not the experiment itself. The experiment (recruiting 3 design partners, installing Janusly in their environment, measuring real MTTR for ~90 days, publishing a report) is operational work owned by the founder. This handbook ensures every instrument the experiment uses is already drafted before the first call.

---

## Section A — How to use this doc

Two consumers, two reading paths.

- **Founder running the first cohort.** Read top-to-bottom once before recruitment begins. During the experiment, lift the specific instrument verbatim (intake form copy, kickoff script lines, survey questions) — never invent on the fly mid-call. The whole point of the handbook is consistency across 3 partners.
- **Future operator scaling beyond the first cohort.** Treat Section L as the index; jump to the section that matches what you're doing this week.

**Voice rules from [`narrative.md`](narrative.md) apply.** Concrete over abstract. Honest about today vs destination. Engineering reality as proof. Never snarky. The same rules that govern customer-facing copy govern the surveys and scripts here — partners read every word the founder writes, and trust starts on the first survey.

**Honesty rule.** Every "we measure X" claim in this handbook is backable in a real Janusly runtime table (`run_events`, `dead_letters`, `usage_events`, `audit_logs`). We never promise a metric we cannot capture from the runtime. Self-reported numbers (baseline MTTR, partner toil estimates) are explicitly marked as soft data in the methodology.

**Lift verbatim, but stay flexible.** Forms and surveys (Sections C, D, F) are lifted unchanged. Conversations (Sections E, G, H) are scripted but the conversation goes where it goes — the script is the agenda, not the dialogue.

---

## Section B — Scope and success criteria

What constitutes "experiment complete":

**Cohort size.** 3 design partners. One per ICP segment if possible (one **B2B startups with ops workflows**, one **Engineering/support teams**, one **AI builders/agencies** — segment names lifted verbatim from [`icp.md`](icp.md)). Diversity beats best-fit; better signal across the ICP than 3 of the same segment.

**Workload.** 3 real production-shaped workflows per partner — their actual work, not the canonical demos. Demos play a role in week 1 onboarding only.

**Duration.** ~90 days from install to exit interview. Breakdown:
- Week 0: recruitment + intake.
- Week 1: kickoff calls (60 min × 3 partners) + first workflow wired per partner.
- Weeks 2–10: weekly cadence (30-min standing call + weekly report per partner).
- Weeks 6–8: willingness-to-pay conversation per partner.
- Weeks 11–12: exit interviews + permission capture.
- Weeks 13–14: internal report drafting.
- Weeks 15–18: external-publishable version (anonymized as needed).

**Success criteria (the "we go to v1 pricing" gate).** All three must hold:
1. At least 2 of 3 partners show measurable MTTR improvement (baseline self-report vs post-install measured median).
2. At least 2 of 3 partners give a concrete willingness-to-pay band that maps to one of the candidate value metrics in [`pricing.md`](pricing.md) Section D (per-seat / per-recovered-run / per-AI-call).
3. Setup friction below the 60-minute "first recovered run" target for at least 2 of 3 partners (measured by the kickoff-call checklist in Section E).

**Failure criteria (the "we re-position before pricing" gate).** Any one of these holding is reason to pause v1 pricing and revisit positioning:
1. Zero partners show measurable MTTR improvement → the wedge is wrong; revisit PLAN §16.0 before publishing any prices.
2. All 3 partners cite the same setup blocker → fix the blocker before re-running the experiment.
3. All 3 partners pivot to wanting a different product shape than Recovery Center → re-examine the product home decision (the ENG-093 AC explicitly empowers this verdict).

**Verdict line for the published report.** Either *"Recovery Center remains the product home; v1 pricing recommendation follows"* or *"We re-position before pricing; here is what we learned."* Both are valid experiment outcomes.

---

## Section C — Recruitment and qualification

How the founder sources, qualifies, and selects the 3 design partners.

### Channels

In priority order:

- **Warm introductions** from advisors, investors, and previous founder relationships. Highest-quality signal; intro-er has already vetted segment fit.
- **The founder's own network** (LinkedIn 1st-degree, prior teammates, communities the founder is in). Second-best.
- **Stage-1 cold outreach** lifted from [`icp.md`](icp.md) — segment-specific cold email + LinkedIn DM copy is already drafted there. Lowest-conversion but broadest reach. Do not modify the icp.md templates; they ride this experiment unchanged.

Target: 15–25 inbound conversations to land 3 design partners. Plan for a ~12% accept rate (segment-fit + availability + decision-maker overlap is rare).

### Qualification heuristics

A candidate is segment-fit if they articulate at least ONE of the seven buying triggers from [`competitive-positioning.md`](competitive-positioning.md) Section E in their own words during the first conversation:

1. "Our automation broke at 3am and we couldn't figure out why."
2. "We need an audit log per AI action for compliance."
3. "Our agent demo works but production keeps breaking."
4. "We tried n8n's error workflows; they don't explain anything."
5. "We're hitting AI cost surprises on our workflows."
6. "Our agency rewrites the same recovery glue per client."
7. "Compliance asked who approved this AI action."

Disqualifiers (lifted from [`icp.md`](icp.md) Stage 2). Polite no, no exceptions:

- "We're not shipping AI to production yet." → Wrong stage. Come back in 6 months.
- "We want a better Zapier UI." → Wrong category.
- "We need an on-prem / air-gapped install." → Out of scope for v1.
- "We're evaluating five vendors and need a 50-question RFP." → Wrong stage for a private-beta product.

### Intake form template

The form goes to every candidate before the qualification call. Copy-pasteable into Google Forms / Typeform / Tally / plain markdown. The founder reads the responses before the call so the call is the discovery + selection conversation, not data collection.

```
Janusly private beta — design partner intake

Thanks for the interest. We're picking 3 design partners for an ~8-12 week private beta of Janusly — the AI workflow runtime with a recovery-first operator surface. This form gives us what we need to know whether the fit is right; we'll respond within 3 business days either way.

1. Company name, your name, your role, team size.
2. Which of these best describes your team? (pick one)
   a) B2B startups with ops workflows (refunds, billing exceptions, escalations, support routing)
   b) Engineering/support teams (incident triage, customer-bug workflows)
   c) AI builders/agencies shipping AI workflows to clients
   d) None of the above (free text)
3. Which of these resonates most with your current pain? (multi-select; pick all that apply)
   - An automation broke and we couldn't figure out why
   - We need an audit log per AI action for compliance
   - Our agent demo works but production keeps breaking
   - We tried our existing tool's error workflows and they don't explain anything
   - We're hitting AI cost surprises on our workflows
   - We rewrite the same recovery glue per project / client
   - Compliance asked who approved an AI action and we couldn't answer
   - None of these (free text)
4. Roughly how many automation failures does your team see per week today? (free text estimate)
5. When something breaks, how long does it typically take to resolve? (pick one)
   <5 min / 5-30 min / 30 min-2 hr / 2-8 hr / 8-24 hr / >24 hr / we don't measure
6. What tool(s) do you currently use for the same job? (multi-select)
   Zapier / Make / n8n / Workato / Pipedream / Relay / Gumloop / homegrown internal tool / nothing yet / other (free text)
7. Do you currently track Mean Time To Recovery (MTTR) for workflow failures? (yes/no, then free text if yes)
8. Pick 3 workflows you would run on Janusly during the private beta. For each, give us a 1-sentence description. (free text, 3 entries)
9. We need a 60-minute kickoff call + a 30-minute weekly check-in for 8-12 weeks. Are you available for that cadence? (yes / yes with caveats / no)
10. Do you have any compliance constraints? (multi-select)
    None / SSO required / SCIM required / audit-log retention required / air-gapped on-prem required / other (free text)
11. Who decides whether your team converts to paid Janusly after the beta? (yourself / someone else — name them / unsure)
12. Anything else we should know? (free text, optional)

We'll respond within 3 business days. If we're a fit, the next step is a 30-minute discovery call.
```

### Acceptance rubric

Once enough intakes are in (target ~15–25), the founder picks 3. Bias toward:

- **Segment diversity.** One per ICP segment is ideal. If two excellent candidates are in the same segment, pick the one with the more concrete pain (specific failure description, not generic "we want better workflows").
- **Decision-maker overlap.** Q11 (themselves vs someone else). If the user is not the buyer, the contract conversation at week 12 will stall. Prefer "themselves" answers.
- **Availability honesty.** Q9 "yes" beats "yes with caveats." Beta partners who can't make the calls stop reporting after week 3.
- **Workflow concreteness.** Q8's three workflows should be named and described — "process refunds when Stripe webhook fires" beats "we run automations." Vague workflows mean the partner doesn't know what they want to test.
- **Compliance honesty.** Q10's "air-gapped" → polite no. Q10's "SSO required" → still a fit (we ship SSO via WorkOS today per AGENTS.md).

Three explicit "no" outcomes from the rubric:
- Air-gapped requirement.
- "None of these" on Q2 AND Q3.
- User-not-buyer (Q11) AND no path to bring buyer to the kickoff.

### Pre-kickoff email template

Goes out within 24 hours of selection. Includes the kickoff calendar invite and the baseline-MTTR survey link.

```
Subject: You're in — Janusly private beta kickoff

[Name],

Welcome to the Janusly private beta. We picked 3 design partners out of [N] candidates; you're one of them.

A few quick things:

1. **Kickoff call: 60 minutes.** Calendar invite attached for [date/time]. We'll install Janusly together, walk the recovery loop, and wire your first workflow live. By the end of the call you should have one workflow running and one recovered failure on the board.

2. **Before the call, please fill the baseline survey.** It's 5 short questions about your current automation pain — takes ~10 minutes. Link: [baseline-survey URL]. We need it before the kickoff so we can pre-load your specifics.

3. **What we'll need from you during the beta.** A 30-minute weekly check-in for 8-12 weeks (we'll book the standing slot during the kickoff). One weekly report (a short form, ~5 minutes to fill). A 30-minute willingness-to-pay conversation around week 6-8. A 45-minute exit interview at the end.

4. **What you'll get from us.** The founder (me) on the line for every conversation. Full free access during the beta. Direct influence on the product roadmap. No commitment to convert to paid — if it doesn't work, we want to know that just as much as we want it to work.

5. **Anything urgent before the kickoff** → reply to this email or DM me on [Slack/LinkedIn].

Looking forward to working with you.

[Founder name]
```

---

## Section D — Baseline measurement (pre-install survey + methodology)

The instrument that captures the partner's "before Janusly" state. Run before the kickoff call so the founder can pre-load the partner's specifics during the install.

### Pre-install baseline survey

Copy-pasteable. Same delivery format as the intake form (Google Forms / Typeform / Tally / plain markdown).

```
Janusly private beta — baseline survey

You'll fill this before the kickoff call. Honest estimates over precise numbers — we know you probably don't measure this today; that's exactly why we're running the experiment together.

1. For each of the 3 workflows you'll run on Janusly during the beta, give us:
   - Workflow name (short, e.g. "refund webhook → approval → Stripe").
   - Trigger source (webhook / cron / manual / event from another system).
   - Expected weekly run count (rough estimate).
   - Expected failure rate today (out of 100 runs, how many fail?).

2. For each of the same 3 workflows, estimate the CURRENT MTTR (time from "we noticed an automation failed" to "the failure is resolved and the workflow can run again"). Use these buckets:
   < 5 min  /  5-30 min  /  30 min - 2 hr  /  2-8 hr  /  8-24 hr  /  > 24 hr

3. For each workflow, describe the last 3 known failures you can remember (1-2 sentences each, the partner's own description). Example: "The Stripe webhook returned a 401 because the API key rotated and nobody updated the env var."

4. Roughly, how many engineer-hours per week does your team spend on automation toil today? (Toil = manual triage of failures, manual retries, manual re-running of broken workflows, paperwork around incidents.) Free text estimate, no precise number needed.

5. Finish this sentence: "Janusly would be obviously worth paying for if it ___." One sentence, the partner's own words.
```

### Measurement methodology

What the founder uses internally to derive the published numbers.

**Baseline MTTR (the "before" number).**
- Source: Question 2 of the baseline survey (partner self-reported, bucketed).
- Coding: each bucket gets a midpoint for arithmetic (`<5min` → 3 / `5-30min` → 17 / `30min-2hr` → 75 / `2-8hr` → 300 / `8-24hr` → 960 / `>24hr` → 2880, in minutes).
- Aggregation: median across the partner's 3 workflows is the partner-level baseline; median of 3 partner-level baselines is the cohort-level baseline.
- **This is soft data.** Self-reported, memory-based, not measured. The published report names it as soft data with the partner's own estimate ranges shown alongside.

**Post-install MTTR (the "after" number).**
- Source: the runtime itself. For each post-install failure, Janusly's current recovery metric is `dead_letters.replayed_at` − `dead_letters.created_at` for rows with `status = "replayed"` (the same shape `GET /recovery/metrics` uses after `POST /dlq/replay` stamps the DLQ row following a sandbox-validated patch).
- Aggregation: median across all observed recovery runs per partner; median of 3 partner-level medians is the cohort-level post-install MTTR.
- **This is hard data.** Captured from runtime timestamps, with `run_events` available as the supporting timeline for the recovery action. The published report names this as hard data.

**The before/after delta.**
- `baseline median (soft)` minus `post-install median (hard)` per partner.
- Cohort delta: median of 3 partner deltas.
- This is the headline number of the published report. The methodology section explicitly names the asymmetry (soft → hard) so a reader can interpret the number without overclaiming.

**Setup friction.**
- Source: kickoff call (Section E). Checklist at the end of the call — did we hit the 60-minute "first recovered run" target?
- Coding: pass / partial-pass (recovered run lands in week 1, not in the kickoff) / fail (recovered run does not land in week 1).
- Aggregation: 3-of-3 / 2-of-3 / 1-of-3 / 0-of-3 partners hit the pass bar.

**Willingness to pay.**
- Source: Section G conversation, week 6–8.
- Output: per-partner band per value metric (per-seat / per-recovered-run / per-AI-call / other). NOT a single number — a band.
- Aggregation: cross-partner pattern, not arithmetic median (3 data points isn't enough for a median; we name the pattern).

### Failure-category coding scheme

Every observed failure (in the partner's workflows during the beta) gets bucketed using the engine's own `ErrorCategory` union (`packages/shared/src/error-signature.ts`). The published report's category histogram maps 1:1 to engineering reality — no marketing-coined categories.

The 7 closed categories:

- `secret_missing` — missing or invalid credential reference (e.g. `BILLING_API_KEY` unbound, `{{secret.X}}` template referencing a non-existent name).
- `http_error` — non-2xx response from an HTTP node or HTTP-using tool (4xx or 5xx; the engine does not split these in the signature today).
- `network_timeout` — request never completed (no response within the configured timeout).
- `ai_provider` — LLM provider returned an error (quota, rate, malformed output, unknown model).
- `parse_error` — output couldn't be parsed (JSON.parse threw, Zod validation rejected).
- `tool_input` — tool was called with invalid input (required field missing, type mismatch).
- `unknown` — everything else (engine could not classify).

The founder logs each failure into the experiment notebook with `{ partnerId, workflowName, runId, category, failureSignature, recoveryActionTaken, MTTR_minutes }`. The published report shows per-partner and per-cohort histograms across these 7 categories.

---

## Section E — Onboarding (60-minute kickoff script)

The first call with each partner. Goal: at minute 60, the partner has Janusly running locally, one workflow wired, one successful run on the board, and one recovered failure on the timeline. If we miss the 60-minute bar, Section B's "setup friction" metric records a partial-pass for that partner.

### Pre-call setup (founder's checklist)

- The partner's intake + baseline survey responses are open in another tab.
- The `failed-workflow-recovery` recording script ([`docs/marketing/recording-scripts/failed-workflow-recovery.md`](recording-scripts/failed-workflow-recovery.md)) is open as the demo backbone.
- The `pnpm seed:demos` command (from ENG-069) is ready to run on the partner's machine via screen-share.
- Recording is on (with partner consent — ask in the first minute).

### Minute-by-minute script

**Minutes 0–5: Context-set.**

Talking points (lift verbatim, adapt to the partner's name and Q2/Q3 responses):

> "Quick context before we install anything. Janusly is built around a simple thesis: recovery, not integration count, is the wedge. Workflow tools were built for the integration era — drag-and-drop connectors. They weren't built for the question 'what happens when the model returns nonsense, the secret expires, or a step that worked yesterday fails today?' That's the question we built for.
>
> What we're doing today: install Janusly together, walk the recovery loop on a demo template, then wire your first real workflow. By the end of this call you should have one workflow running and one recovered failure on the board. That's the 60-minute target.
>
> What we measure during the beta: Mean Time To Recovery for your real workflows. We have your baseline survey already (the self-reported number from before today); we measure the post-install MTTR from the runtime itself. That's the experiment. Sound good?"

**Minutes 5–15: Install.**

Walk the partner through the README Quick-start, condensed:

1. `git clone` Janusly + `pnpm install`.
2. Set environment: `ANTHROPIC_API_KEY` (the partner pastes their own or uses the BYO key). Dev-mode auth needs no separate setup when Supabase is unset and `NODE_ENV !== "production"`; `x-org-id: default` and `x-user-id: dev-user` headers ride automatically from the web.
3. `pnpm dev` brings Postgres + Redis up via Compose, runs migrations, then starts api + worker + web at http://localhost:5173.
4. In a second terminal, `pnpm seed:demos` writes the three canonical demo credentials (idempotent — no-op if they already exist; `--force` resets per ENG-069).
5. Open http://localhost:5173.

**Friction watchpoints (founder narrates aloud while the partner runs the commands):**
- Node 24 required (check `node --version`). Older Node → `nvm use 24` or `corepack enable`.
- Docker required. If the partner does not have Docker → mark setup as `partial-pass` for the friction metric; they can complete locally with their own Postgres + Redis but it's not a 60-minute path.
- Anthropic key not set → AI surfaces degrade to deterministic fallback per AGENTS.md; the recovery loop still works structurally but `POST /ai/explain-run` and `POST /ai/patch-workflow` return `mode: "fallback"`. Document this in the friction notes.

**Minutes 15–25: Recovery loop walkthrough on the demo template.**

Follow the `failed-workflow-recovery` recording script. The beats:

1. Open the `failed-workflow-recovery` template in AI Studio.
2. Save it, run it with the sample payload, and let the intentionally unbound `{{secret.BILLING_API_KEY}}` failure land in DLQ.
3. Open the Recovery Center home; click the failed run and show the AI-explained root cause from `POST /ai/explain-run`.
4. Open the recovery dialog; show the 1–3 patch suggestions from `POST /ai/patch-workflow` with confidence + approachLabel.
5. Pick the structural approval suggestion first. Click "Apply & validate" — `POST /dlq/validate-fix` runs the sandbox replay (writes-skipped per AGENTS.md dryRun gate). Save the new version.
6. Re-run the patched workflow, approve the new human gate, and let the still-unbound secret fail again.
7. Re-open the recovery dialog, pick the `swap_secret_ref` suggestion, validate the patch, and save the next version.
8. For a live-green close, wire the replacement secret + reachable billing sandbox endpoint, then click "Replay" via `POST /dlq/replay`. Watch the workflow run through to green.

Partner observation prompt: "Walk me through what you just saw — what's different from your current tool's failure path?"

**Minutes 25–45: First real workflow.**

The partner picks the simplest of the 3 workflows from Q8 of the intake. The founder co-pilots while the partner wires it.

- New workflow → name from intake Q8.
- Add the trigger node (webhook / cron / manual depending on intake Q8).
- Add the work nodes (HTTP / AI / tool steps).
- Save the first version.
- Run once successfully (founder helps adjust the test trigger payload if needed).
- **Intentionally break it.** Rotate the credential. Inject a 401. Drop a required field from the trigger payload. The break should match the failure shape from Q3 of the baseline survey ("the last 3 failures") if possible.
- Open Recovery Center → the partner's own workflow lands in DLQ.
- Walk recovery: explain → patch → sandbox → apply → replay. The partner clicks; the founder narrates.

**Minutes 45–55: Their other 2 workflows.**

The partner names the remaining 2 from intake Q8. We don't wire them live today — the partner commits to wiring workflow #2 by end of week 1 and workflow #3 by end of week 2. The founder offers a 30-min wiring session if the partner is blocked.

**Minutes 55–60: Weekly cadence agreement.**

- Pick the standing 30-min slot (same time every week for 8–12 weeks).
- Confirm the weekly-report cadence (partner fills the report by Friday EOD; founder reads before the standing call).
- Set the communication channel for between-meeting friction (Slack channel / Discord / email thread — partner's preference).
- Mention the willingness-to-pay conversation at week 6–8 ("a 30-minute conversation about pricing — discovery, not negotiation").
- Mention the exit interview at week 12 ("45-minute wrap, we capture what we learned together").

### Setup checklist (end-of-kickoff "ready" definition)

The kickoff call counts as a `pass` on the setup-friction metric if at minute 60 ALL of the following are true:

- [ ] `pnpm dev` running locally (api + worker + web at http://localhost:5173).
- [ ] Dev-mode auth working (`/workflows` endpoint returns 200 with the default org).
- [ ] At least one workflow wired (the partner's, from intake Q8).
- [ ] At least one successful run on that workflow.
- [ ] At least one recovered failure on the same workflow (or the demo template if the partner's workflow couldn't be intentionally broken cleanly).
- [ ] Weekly cadence slot agreed and on the calendar.

`partial-pass` = the partner's workflow wires by end of week 1 (not at minute 60). `fail` = the partner's workflow does not wire by end of week 1.

### Hand-off email template

Within 24 hours of the kickoff:

```
Subject: Janusly kickoff recap + week 1 plan

[Name],

Great kickoff. Quick recap and the week 1 plan:

What's set up today:
- Janusly running locally via `pnpm dev`
- Workflow [#1 name] wired, [N] successful runs, [M] recovered failure(s)
- Anthropic key configured (or: degrading to fallback — fine for the structural recovery loop)

Week 1 plan:
- Wire workflow [#2 name] by [Friday date]
- File the weekly report at [link]
- Standing call: [day/time] starting [next week date]

Resources you'll need:
- README Quick-start (Janusly install): [link to README anchor]
- Recovery loop recording: [recording-scripts/failed-workflow-recovery.md link]
- Slack channel for friction: [link]

If something blocks you mid-week, DM me on Slack — I respond within 4 business hours. Serious blockers: same-day call.

Talk soon.

[Founder name]
```

---

## Section F — Weekly cadence

The rhythm during weeks 2–10. Standing call + weekly report + between-meeting protocol.

### Standing 30-minute call agenda

Same structure every week. The partner knows what to expect; the founder doesn't have to re-explain the format.

- **Minutes 0–5: Partner-led wins / friction.** Partner walks through what worked and what didn't since last week. Open-ended; the founder listens, doesn't interrupt unless asked.
- **Minutes 5–15: Founder-led runtime walk.** Founder pulls the partner's workflow run timeline on screen-share: DLQ entries, recovery actions taken, MTTR observed this week. The founder reads the numbers; the partner reacts.
- **Minutes 15–25: Next step.** Pick what to wire / fix / explore next. Could be a new workflow, a new node type, a new feature (recovery feedback loop, cluster apply, version rollback). The founder optionally walks a new product surface in 5 minutes if relevant.
- **Minutes 25–30: Close.** Confirm next call date. Confirm any homework (e.g. "you fill the weekly report by Friday"). Slack channel for friction.

### Weekly-report template

The partner fills it by Friday EOD before the next-week standing call. Copy-pasteable into the same form tool the intake used.

```
Janusly weekly report — week of [date]

1. Workflows added or removed this week:
   (Free text. E.g. "Added 'churn-risk-followup' on Tuesday. Removed 'old-refund-v1' — replaced by 'refund-triage-v2'.")

2. Total runs this week, by workflow:
   (Approximate counts. You can read them from `GET /runs` or eyeball the dashboard.)

3. Failures this week, by workflow:
   (Approximate counts. DLQ entries + failed run nodes.)

4. Recovery actions taken:
   - Patch suggestions accepted: [N]
   - Patch suggestions rejected: [N]
   - Sandbox validation runs: [N]
   - Production replays: [N]
   - Version rollbacks: [N]

5. Observed MTTR this week, per workflow:
   (For each workflow where you ran a recovery: estimated minutes from failure to recovered replay. Don't worry about precision; ranges are fine.)

6. Friction worth naming (1-3 items):
   (Free text. Anything that slowed you down, confused you, or felt clunky. Even "the dialog took 3 clicks instead of 1" is useful signal.)

7. Surprise of the week:
   (One sentence. Anything Janusly did this week that you didn't expect — positive OR negative. We learn the most from these.)

8. Confidence in continuing the beta (1-5):
   (Only from week 2 onward. 1 = "I'm considering dropping out." 5 = "I'm in for the duration.")
```

### Founder's internal experiment notebook

Per partner-week, the founder logs:

```
Partner: [name]
Week: [N]
Workflows active: [count]
Total runs observed: [count]
DLQ entries observed: [count]
Recovery actions:
  - Suggestions accepted: [count]
  - Suggestions rejected: [count]
  - Sandbox validations: [count]
  - Production replays: [count]
  - Rollbacks: [count]
MTTR samples this week (minutes):
  [list, one per recovery run]
Failure-category histogram this week:
  secret_missing: [count]
  http_error: [count]
  network_timeout: [count]
  ai_provider: [count]
  parse_error: [count]
  tool_input: [count]
  unknown: [count]
Accept-rate on patch suggestions: [%]
Confidence (partner self-reported, Q8 of weekly): [1-5]
Willingness-to-pay temperature (founder's read, 1-5): [1-5]
Notes:
  [free text observations]
```

Keep this in a markdown file or spreadsheet — one row per (partner, week). The published report aggregates from these rows.

### Between-meeting protocol

- **Slack channel per partner (or shared #janusly-beta channel if 3 partners are comfortable being in the same room).** Founder responds within 4 business hours during the work day.
- **Serious blocker = same-day call.** Definition of "serious": the partner cannot run their workflow, the partner is considering dropping out, the partner's compliance team raised a concern. Anything else can wait for the standing call.
- **Bug found in Janusly = open an issue.** Founder triages and either fixes inline (collateral fix policy) or files a ticket. Partner does not need to wait — workaround comes from the founder same-day.
- **Friction worth telegraphing = name it in the weekly report.** Section F item 6 is the structured channel for non-blocking friction.

---

## Section G — Willingness-to-pay conversation

The pricing-discovery instrument. Run between weeks 6 and 8 once the partner has experienced the recovery loop solving a real failure at least once. Tied to [`pricing.md`](pricing.md) Section G's "pricing release plan" — this conversation produces the data that turns pricing.md's candidate value metrics into v1 numbers.

### Pre-conditions

Do not run this conversation until ALL three hold:

- [ ] Partner has accepted at least 3 patch suggestions in production via the Recovery Center.
- [ ] MTTR delta is observable on at least one of the partner's workflows (post-install median < baseline self-reported median).
- [ ] Partner has experienced the recovery loop solving a real (non-demo) failure at least once.

If any condition is missing at week 6, defer to week 7 or 8. If still missing at week 8, run the conversation but note in the published report that this partner's WTP signal is weaker (less value experienced = less ability to price it).

### Format

**30-minute conversation, NOT a Typeform.** Numbers come from talking, not from a slider. The founder schedules a dedicated call, frames it as discovery (not negotiation), and lets the conversation breathe.

### Opening frame (lift verbatim)

> "Today's call is different from the weekly check-in. We're going to talk about pricing — but it's discovery, not negotiation. I'm not going to quote you a price; you're not going to give me one. What I want is your honest read on what Janusly is worth to your team. The data from this conversation, combined with the same conversation from the other two design partners, is what we'll use to set v1 pricing. So your answers shape what other customers see — not your invoice. Sound good?"

### Question script (open-ended; the conversation goes where it goes)

1. **Replacement difficulty.** *"Honest read: if Janusly disappeared tomorrow, what's your team's plan?"*
   - Listen for: "we'd build it ourselves" (high WTP — they value the engineering already done) / "we'd go back to [tool]" (medium WTP — they value the upgrade but have a fallback) / "we'd live without it" (low WTP — re-examine value).

2. **Value metric preference (without priming).** *"If I told you we're going to charge for this, what's the first metric you'd want to pay on — seats, recovered runs, AI calls, something else?"*
   - **Do not list the metrics first.** Let them volunteer. Then probe: "Why that one? What about the others?"
   - The three candidates from [`pricing.md`](pricing.md) Section D are: per-seat, per-recovered-run, per-AI-call. If they name something else, write it down verbatim — that's new signal for the report.

3. **Unit value derivation.** *"Walk me through the math: what's a single recovered run worth to your team in engineer-minutes? Just dollar back-of-the-envelope it for me."*
   - Listen for: their engineer-cost per hour × MTTR-saved-per-recovery. This is the partner's own unit-economics; the founder doesn't supply it.

4. **Price bands (not points).** *"What's the band you'd renew at without an internal escalation? What's the band where you'd need to go to a budget owner?"*
   - **Always bands, never points.** A point ("$1500/month") feels like negotiation; a band ("renew under $2k, escalate above $5k") feels like discovery. The published report aggregates bands.

5. **Competitive anchor.** *"If you're paying for [Zapier / n8n / Make / whatever they named in intake Q6], what do you pay today, and per what?"*
   - Anchors the partner's price intuition. Often the most useful data point — the partner knows their existing tool's bill better than they know what a new tool "should" cost.

6. **Billing cadence.** *"Annual contract or monthly? Why?"*
   - Listen for: budget cycle preferences. Often "annual but with quarterly invoicing" or "monthly until we trust it, annual after."

7. **Commitment lever.** *"If we asked for a 12-month commit at the lower end of your band, what would you want in return?"*
   - Surfaces the discount-for-commitment lever for future deal terms. Listen for: discount %, white-glove onboarding, custom feature, named TAM.

### What the founder captures

Per partner, one form filled in the experiment notebook:

```
Partner: [name]
WTP conversation date: [date]
Pre-conditions met: [yes / partially]

Replacement difficulty signal: [build ourselves / fall back to tool / live without]
Preferred value metric: [per-seat / per-recovered-run / per-AI-call / other]
  Why: [partner's own reason in 1-2 sentences]
Unit value (their math): [their stated dollar-per-recovered-run or equivalent]
Renew band: [low - high, no escalation]
Escalate band: [low - high, requires budget owner]
Competitive anchor: [what they pay today + per what + for which tool]
Billing cadence preference: [annual / monthly / hybrid]
Commitment lever: [what they'd want for a 12-month commit]
Founder's read (1-5, gut call): [1-5]
Verbatim quote worth keeping: [1 sentence in partner's own words]
```

### What we never do in this conversation

- **Quote a price.** The instrument is discovery, not negotiation. Pricing.md Section G's existing answer — *"we'll work with your team on pricing once we both know the workload"* — stays the answer if the partner asks.
- **Promise a discount.** Discount terms come later, in the exit-interview-to-paid handoff or after.
- **Show pricing.md to the partner.** That doc is internal sales context, not customer collateral.
- **Compare bands across partners during the call.** Each partner gets a fresh conversation. Cross-partner comparison happens internally in the published report.

---

## Section H — Exit interview (90-day wrap-up)

End of the beta. The conversion-or-churn moment + permission capture for everything we want to use externally.

### Pre-meeting prep

48 hours before the exit call, the founder sends the partner a 1-page summary of the 90-day observation. The partner reads it before the call so the call is reaction + permission + decision, not data presentation.

The summary template:

```
Janusly private beta — [Partner] 90-day summary

Workflows wired during beta: [N]
Total runs observed: [N]
DLQ entries observed: [N]
Recoveries via Recovery Center: [N]
Patch suggestions accepted: [N] ([%] accept rate)
Sandbox validations: [N]
Production replays: [N]
Version rollbacks: [N]

MTTR baseline (your self-reported median, weeks 0): [N] minutes
MTTR observed (engine-measured median, weeks 1-10): [N] minutes
Delta: [N] minutes ([%] improvement)

Top 3 failure categories observed:
1. [category]: [N] failures
2. [category]: [N] failures
3. [category]: [N] failures

Top quote of the beta (yours): "[partner quote from a weekly report]"
Top friction of the beta: [friction item]
Top surprise of the beta: [surprise from a weekly report]

Tomorrow's exit interview will cover: case study, conversion-or-churn, permission capture. We'll keep it under 45 minutes.
```

### 45-minute call agenda

- **Minutes 0–10: Summary review.** Founder walks the summary. Partner corrects anything that misrepresents their experience. Bias toward listening over defending — the partner's read of the data is more important than ours.

- **Minutes 10–20: Case study.** *"If a friend at another company asked you about Janusly today, what would you tell them?"* Listen for the 1-2 sentence summary the partner would give. Ask: *"Can I quote you on that? With or without your name? With or without the number?"* — capture the case-study permission inline.

- **Minutes 20–30: Conversion decision.** *"What would have to be true for you to convert to a paid Janusly subscription? Price, feature, contract terms, compliance — what's the gate?"* Listen for: pricing band (the WTP from Section G should match), feature gap (named explicitly), contract requirement (SSO / SCIM / DPA / SOC2), or "we're in, just send the contract."

- **Minutes 30–35: Churn trigger.** *"What would have to be true for you to leave Janusly? Honest, in your own words."* This is the most important answer in the call. Write it verbatim.

- **Minutes 35–40: Budget allocation.** *"If you had $[X — the lower band from their Section G band] right now to spend on workflow tools, how would you split it across vendors? Janusly, [their existing tool], anything else."* Listen for: % allocation. A partner who'd put 100% on Janusly is a convert; 50/50 is a coexist; <25% means we're a complement, not a replacement.

- **Minutes 40–45: The "what should we have asked" question.** *"Anything we should have asked but didn't?"* Often the most valuable question in the call. Free-form.

### Permission capture (explicit, written, in the call)

Read each prompt aloud, capture the partner's yes/no/anonymized answer verbatim. Send a written summary within 24 hours for the partner to confirm by reply (legal protection for downstream marketing use).

```
Permission capture — [Partner] exit interview

1. May we cite your MTTR-delta number in marketing?
   [ ] Yes, with attribution to the company
   [ ] Yes, anonymized as "an engineering team" or "a B2B startup"
   [ ] No

2. May we list your company logo on the Janusly landing page trust strip?
   (This swaps the existing placeholder copy at landing-page.md line 134 / 402 for a real logo.)
   [ ] Yes
   [ ] No

3. May we publish the failure-category breakdown observed in your workflows?
   [ ] Yes, with attribution
   [ ] Yes, anonymized
   [ ] No

4. May we publish a case-study page on your beta experience?
   [ ] Yes, drafted by us, you approve before publication
   [ ] Yes, anonymized
   [ ] No

5. May we use the verbatim quote you gave at minute 10–20 in marketing?
   [ ] Yes, with attribution
   [ ] Yes, anonymized
   [ ] No

Partner signature: ___________________
Date: ___________________
```

### Conversion-or-churn outcome

Every exit interview ends with one of three outcomes. The published report names which 3 of 3 happened. All three are valid experiment outcomes.

- **Outcome A: Convert.** Partner says "we're in." Handoff: send a 30-day contract draft within 48 hours, with terms anchored on Section G's stated band. If they want a 12-month commit, apply the lever from Section G question 7. Schedule the kickoff-to-paid call.
- **Outcome B: Coexist.** Partner stays on the free tier with no immediate paid commitment but no churn either. Ongoing relationship, no contract. Schedule a quarterly check-in to revisit.
- **Outcome C: Churn.** Partner doesn't convert and doesn't continue. Capture the churn-trigger answer from minute 30–35 — that's gold for the next experiment. Send a thank-you email + offer to stay in touch.

---

## Section I — Private-beta report template

The deliverable named in the ENG-093 AC: *"publish a private-beta report that decides whether Recovery Center remains the primary product home."*

### Format

Internal-first publication. Lives at `docs/marketing/private-beta-report.md` (created by the FUTURE ENG-093 work; this playbook ships only the template, not the populated report). External publication (blog post, case study landing page, deck) is downstream once Section H permissions are captured.

### Required sections (the skeleton)

1. **Executive summary.** Three numbers and one verdict sentence.
   - **MTTR delta (cohort median):** [N] minutes baseline → [N] minutes observed = [%] improvement.
   - **Success-criteria hits:** [3 / 3] or [2 / 3] or [1 / 3] partners hit all three Section B success criteria.
   - **Willingness-to-pay aggregate band:** [low – high] per [value metric].
   - **Verdict:** *"Recovery Center remains the primary product home; v1 pricing recommendation follows."* OR *"We re-position before pricing; here's what we learned."*

2. **Cohort description.** 3 partners, named or anonymized per Section H permissions. For each: ICP segment, company size, primary workflow shape, 1-sentence pain quote.

3. **Methodology.** Pulled verbatim from this playbook's Section D. The report cites the playbook for methodology rather than restating the whole thing.

4. **Findings per partner.** For each of 3 partners, a 1-page subsection:
   - Baseline MTTR (self-reported, soft data, range shown).
   - Post-install MTTR (engine-measured, hard data, median shown).
   - Failure-category distribution (the 7-category histogram from Section D).
   - Patch-suggestion accept rate (from the experiment notebook).
   - Willingness-to-pay band (Section G output).
   - 1-sentence verbatim quote (with permission from Section H).
   - Outcome: convert / coexist / churn.

5. **Cross-partner aggregate.** The three numbers in the executive summary, with their derivation explained. Show the per-partner inputs that fed the cohort medians. Honesty about small-N (3 data points; we name patterns, not statistical significance).

6. **Wedge verdict.** Does the data say:
   - "Recovery Center remains the product home" (Section B success criteria met: ≥ 2 of 3 partners + ≥ 2 of 3 WTP signals + ≥ 2 of 3 setup friction passes)?
   - Or "We re-position before pricing" (any of Section B failure criteria triggered)?

7. **v1 pricing recommendation.** Specific value metric (per-seat / per-recovered-run / per-AI-call / other if the data surfaced one) + recommended band (low – high) + billing cadence preference + commitment-lever shape. Feed forward into pricing.md Section G's "After ENG-093 closes" trigger.

8. **Open questions.** What 90 days didn't resolve. Candidates for the next experiment (a second cohort, a single-segment deep-dive, a feature-gap-validation run, etc.). Honest about the cohort size limit.

9. **Permissions ledger.** Per partner, per artifact type, what consent was captured. The reference for every external use of beta data downstream (case-study landing page, conference talk, sales slide).

### Publication cadence

- **Weeks 13–14:** internal report draft. Founder writes; aggregates the experiment notebook. Cross-check with each partner before external publication (partner sees the section about them first).
- **Weeks 15–18:** external-publishable version. Anonymized as needed per Section H. Lives at the same path; an `external/` variant strips identifying details.
- **Post-publication:** logos / case studies / conference materials follow individual partner permission. Each external artifact references the report's permissions ledger.

---

## Section J — Operational checklist (the "what's running this week" cheat sheet)

A scan-friendly summary the founder keeps open during the beta. Same role [`pricing.md`](pricing.md) Section I plays for sales.

```
Janusly private beta — operational status

Cohort: 3 partners
Start date: ____
Exit-interview date target: ____ (Start + 12 weeks)
Internal-report publish target: ____ (Start + 14 weeks)
External-publish target: ____ (Start + 18 weeks)

Per-partner status:

Partner 1: [name] | Segment: [icp segment] | Kickoff: [✓ pass / partial / fail]
  Workflow 1 wired: [✓ / week N / pending]
  Workflow 2 wired: [✓ / week N / pending]
  Workflow 3 wired: [✓ / week N / pending]
  WTP conversation done: [✓ week N / pending]
  Exit interview done: [✓ / pending]
  Outcome: [convert / coexist / churn / TBD]

Partner 2: [...same structure...]
Partner 3: [...same structure...]

Success-criteria threshold tracking:
  MTTR improvement ≥ 2 / 3: [on track / at risk / failed]
  WTP signal ≥ 2 / 3: [on track / at risk / failed]
  Setup friction pass ≥ 2 / 3: [✓ N partners passed / N pending / failed]

Failure-criteria threshold tracking:
  Zero MTTR improvement: [no / yes — reconsider wedge]
  Shared setup blocker across 3: [no / yes — fix blocker name]
  All 3 want different product shape: [no / yes — revisit PLAN §16.0]
```

The founder updates this every Monday morning before the week's standing calls.

---

## Section K — Out of scope (what this playbook does NOT cover)

- **Running the experiment itself.** This is the handbook of instruments. Running it is operational founder work — recruiting, scheduling, holding the calls, logging the notebook, writing the report.
- **External-publishable artifacts.** Blog post, conference talk, case-study landing page, sales-deck slides — all downstream once Section H permissions are captured.
- **Vendor-grade compliance documentation.** SOC2 attestations, DPA templates, security questionnaire libraries — different work stream. Use AGENTS.md internally as the source of operational truth if a partner asks, but do not send it as customer collateral and do not draft compliance docs inside this playbook.
- **Per-region / per-locale recruitment.** v1 runs in English. Spanish-localized intake forms and surveys are a future ticket once we have Spanish-speaking design partners. The brand voice rules from `narrative.md` apply equally to both languages when that lands.
- **Automation of the experiment notebook.** The founder maintains the notebook by hand (markdown file or spreadsheet). A bespoke "private-beta dashboard" UI is out of scope — the experiment is too small (3 partners × ~12 weeks) to justify tooling.
- **Multi-cohort runs.** This is the playbook for the FIRST 3-partner cohort. If we run a second cohort (a tightening pass with different segments, a feature-gap-validation run, a regional expansion), the playbook gets a new section then — but the v1 path is one cohort, one publication, one v1 pricing decision.
- **Modifying ENG-093's AC.** This playbook ENABLES ENG-093; it doesn't redefine the AC. ENG-093 stays Pending in the ROADMAP until the experiment actually runs and produces a report.

---

## Section L — Cross-references (reverse-link table)

For future readers navigating back from this playbook to its downstream consumers:

| Section in this playbook | Consumed by |
| --- | --- |
| Section B success criteria + verdict | [`pricing.md`](pricing.md) Section G ("After ENG-093 closes") |
| Section C qualification heuristics | [`competitive-positioning.md`](competitive-positioning.md) Section E (the 7 buying triggers) |
| Section C intake form Q2 (segment self-id) | [`icp.md`](icp.md) (3 canonical segments) |
| Section D failure-category coding scheme | `packages/shared/src/error-signature.ts` (the 7-value `ErrorCategory` enum) |
| Section D measurement methodology | The published private-beta report (Section I) |
| Section E demo backbone | [`recording-scripts/failed-workflow-recovery.md`](recording-scripts/failed-workflow-recovery.md) |
| Section G WTP conversation output | [`pricing.md`](pricing.md) Section G (v1 number selection) |
| Section H permission capture | [`landing-page.md`](landing-page.md) trust-strip (logo permission), case-study landing page (future) |
| Section I published report | [`pricing.md`](pricing.md) Section G ("After ENG-093 closes" trigger), future blog post / conference talk |

Every downstream consumer that exists today is listed. Future consumers (case-study landing page, blog post) get added to this table when they ship.
