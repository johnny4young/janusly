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
3. `pnpm dev` brings Postgres + Redis + Ollama up via Compose, runs migrations, then starts api + worker + web at http://localhost:5173.
4. In a second terminal, `pnpm seed:demos` writes the three canonical demo credentials (idempotent — no-op if they already exist; `pnpm seed:demos -- --force` resets per ENG-069).
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
- **Per-region / per-locale recruitment.** Recruitment runs in English in v1 (the founder owns the experiment in English; the partners run real workflows in English). Spanish-localized instruments (intake form, surveys, kickoff script, weekly report template, WTP conversation, exit interview) are shipping in the `Versión en español` block below — operators on the founder side who prefer Spanish can read every instrument in their language. The brand voice rules from `narrative.md` apply equally to both languages.
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

---

## Versión en español

La versión paralela en castellano del **manual operacional de la beta privada** de Janusly. Misma estructura, mismas anclas, misma engineering reality. El experimento mismo se sigue corriendo en inglés en v1 (los partners hacen sus workflows en inglés; los consentimientos legales se firman en inglés); este bloque permite que un fundador u operador hispanohablante lea cada instrumento (intake form, encuestas, scripts, plantillas) en su propio idioma sin improvisar.

Identificadores que quedan en inglés en ambos idiomas — son código o tokens canónicos, no texto traducible: rutas (`POST /ai/explain-run`, `POST /ai/patch-workflow`, `POST /dlq/validate-fix`, `POST /workflows/rollback`, `POST /dlq/replay`, `GET /recovery/metrics`, `GET /dlq/clusters`, `GET /billing/budget`, `GET /run/:id`, `GET /runs`, `GET /workflows`); tablas (`run_events`, `dead_letters`, `usage_events`, `audit_logs`, `workflow_versions`, `recovery_feedback`, `org_configs`, `workflow_budgets`); archivos de código (`packages/shared/src/error-signature.ts`, `RecoveryCenterPanel.tsx`, `packages/mcp-server`); env vars (`ANTHROPIC_API_KEY`, `BILLING_API_KEY`, `JANUSLY_*`, headers `x-org-id`, `x-user-id`, `NODE_ENV`); productos terceros (Postgres, Redis, BullMQ, React Flow, OpenTelemetry, OpenAI, Anthropic, WorkOS, Slack, GitHub, Resend, SendGrid, Loom, Calendly, Notion, Linear, Discord, Stripe, Zapier, Make, n8n, Workato, Pipedream, Relay, Gumloop, Tally, Typeform, Google Forms); demo filenames (`failed-workflow-recovery`, `refund-triage`, `incident-triage`, `multi-agent-decision`, `mcp-notion-summary`); siglas (MTTR, DLQ, MCP, OTel, RBAC, SSO, SCIM, SLA, BYO, OIDC, SAML, ICP, WTP, RFP, NPS, CSAT, KPI, OKR, DPA, SOC2, TAM); ticket IDs (ENG-093, ENG-095, ENG-068, ENG-109, ENG-110, ENG-069); constantes OTel (`service.name="janusly"`, `eq(<table>.orgId, auth.orgId)`); approachLabels (`add_retry`, `raise_timeout`, `swap_secret_ref`, `add_approval`, `fix_url`, `other`); node types (`ai`, `agent`, `multi_agent`, `router_llm`, `agent_reflection`, `mcp_tool`); el brand-mark "Janusly" tampoco se traduce.

**Mail-merge tokens en inglés en ambos idiomas** (convención de `icp.md`): `[name]`, `[company]`, `[link]`, `[agency]`, `[role]`, `[workflow]`, `[date]`, `[Name]`, `[N]`, `[Founder name]`, `[Partner]`, `[#1 name]`, `[#2 name]`, `[Friday date]`, `[day/time]`, `[next week date]`.

**Los 7 valores cerrados del enum `ErrorCategory` quedan en inglés verbatim en ambos idiomas** porque son identificadores de código de `packages/shared/src/error-signature.ts`: `secret_missing`, `http_error`, `network_timeout`, `ai_provider`, `parse_error`, `tool_input`, `unknown`. Traducirlos sería bug.

**Los marcadores de tiempo del kickoff script (Sección E) quedan verbatim:** `0:00`, `5:00`, `15:00`, `25:00`, `45:00`, `55:00`, `60:00`. Mismas convenciones que usa el script en inglés.

**Field names en plantillas (Sección F weekly-report, Sección I report skeleton) quedan en inglés en ambos idiomas** porque otros docs (en particular `pricing.md` Section G) los referencian por nombre: "MTTR delta", "Setup friction notes", "WTP signal", "MTTR baseline", "MTTR observed", "patch suggestions accepted", "production replays", "failure-category histogram".

**Las 5 líneas de captura de permisos en Sección H se quedan verbatim en inglés** dentro del bloque de código. Son consentimientos legales que el partner firma en inglés. Solo la prosa de instrucciones alrededor se traduce. Esto significa que un partner hispanohablante lee las instrucciones en español pero firma su consentimiento en inglés — carve-out intencional por consistencia legal.

Vocabulario canónico, lifted de [`narrative.md`](narrative.md) Versión en español: `autoreparable`, `Centro de Recuperación`, `flujo` / `flujo de trabajo`, `operador`. Quedan en inglés como anglicismos técnicos aceptados del nicho: `sandbox`, `rollback`, `DAG`, `MTTR`, `self-host`, `MCP`, `loop de recuperación`, `kickoff`, `discovery call`, `exit interview`, `intake form`, `weekly report`, `case study`, `setup friction`, `cohort`, `hand-off`, `pre-call`, `between-meeting`, `permission capture`, `success criteria`, `failure criteria`, `verdict`, `bands not points` (se renderiza como "rangos, no puntos exactos"), `data dura` / `data blanda`. Tono: `tú` informal, nunca `usted`. Tags de honestidad (no usados en este doc, pero reservados por consistencia con el stack): `(en producción)`, `(roadmap)`, `(objetivo de empaquetado)`, `(caso a caso)`.

**El experimento mismo se corre en inglés.** Este bloque es para que un operador hispanohablante pueda leer cada instrumento en su idioma — no es una traducción del experimento. Los partners firman sus consentimientos en inglés; los reportes publicados (Sección I) se escriben en inglés. Si en algún momento corre una versión hispana del experimento (segundo cohort en LatAm, por ejemplo), los instrumentos en español están listos.

### Sección A — Cómo usar este doc

Dos consumidores, dos caminos de lectura.

- **Fundador corriendo el primer cohort.** Lee top-to-bottom una vez antes de que empiece el reclutamiento. Durante el experimento, lift el instrumento específico verbatim (copy del intake form, líneas del kickoff script, preguntas de la encuesta) — nunca inventes sobre la marcha mid-call. El punto del manual es consistencia a través de los 3 partners.
- **Operador futuro escalando más allá del primer cohort.** Trata la Sección L como índice; salta a la sección que coincide con lo que estás haciendo esta semana.

**Las reglas de voz de [`narrative.md`](narrative.md) aplican.** Concreto sobre abstracto. Honesto sobre el hoy vs el destino. Engineering reality como prueba. Nunca desprecio. Las mismas reglas que gobiernan copy customer-facing gobiernan las encuestas y scripts acá — los partners leen cada palabra que el fundador escribe, y el trust empieza en la primera encuesta.

**Regla de honestidad.** Cada claim de "medimos X" en este manual es respaldable en una tabla real del runtime de Janusly (`run_events`, `dead_letters`, `usage_events`, `audit_logs`). Nunca prometemos una métrica que no podemos capturar desde el runtime. Los números self-reported (baseline MTTR, estimaciones de toil del partner) están marcados explícitamente como data blanda en la metodología.

**Lift verbatim, pero quedate flexible.** Formularios y encuestas (Secciones C, D, F) se liftean sin cambios. Conversaciones (Secciones E, G, H) están scripted pero la conversación va a donde tiene que ir — el script es la agenda, no el diálogo.

### Sección B — Alcance y criterios de éxito

Qué constituye "experimento completo":

**Tamaño del cohort.** 3 design partners. Uno por segmento ICP si es posible (uno **B2B startups with ops workflows**, uno **Engineering/support teams**, uno **AI builders/agencies** — nombres de segmento liftados verbatim de [`icp.md`](icp.md)). Diversidad le gana al best-fit; mejor señal a través del ICP que 3 del mismo segmento.

**Workload.** 3 flujos production-shaped reales por partner — su trabajo real, no los demos canónicos. Los demos juegan un rol solo en el onboarding de la semana 1.

**Duración.** ~90 días desde install hasta exit interview. Desglose:
- Semana 0: reclutamiento + intake.
- Semana 1: llamadas de kickoff (60 min × 3 partners) + primer flujo cableado por partner.
- Semanas 2–10: cadencia semanal (llamada recurrente de 30 min + reporte semanal por partner).
- Semanas 6–8: conversación de willingness-to-pay por partner.
- Semanas 11–12: exit interviews + captura de permisos.
- Semanas 13–14: drafting del reporte interno.
- Semanas 15–18: versión externa publicable (anonimizada según necesidad).

**Criterios de éxito (el gate de "vamos a v1 pricing").** Los tres tienen que sostenerse:
1. Al menos 2 de 3 partners muestran mejora de MTTR medible (baseline self-report vs mediana post-instalación medida).
2. Al menos 2 de 3 partners dan una banda concreta de willingness-to-pay que mapea a uno de los candidatos de métrica de valor en [`pricing.md`](pricing.md) Section D (per-seat / per-recovered-run / per-AI-call).
3. Setup friction por debajo del target de 60 minutos "primer recovered run" para al menos 2 de 3 partners (medido por el checklist de la kickoff call en Sección E).

**Criterios de falla (el gate de "re-posicionamos antes de pricing").** Cualquiera de estos sosteniéndose es razón para pausar v1 pricing y revisitar el posicionamiento:
1. Cero partners muestran mejora de MTTR medible → la cuña está mal; revisita PLAN §16.0 antes de publicar precios.
2. Los 3 partners citan el mismo blocker de setup → arregla el blocker antes de re-correr el experimento.
3. Los 3 partners pivotean a querer una shape de producto diferente al Centro de Recuperación → re-examina la decisión del product home (el AC de ENG-093 empodera este verdict explícitamente).

**Línea de verdict para el reporte publicado.** O *"El Centro de Recuperación permanece como product home; sigue la recomendación de pricing v1"* o *"Re-posicionamos antes de pricing; esto es lo que aprendimos."* Ambos son outcomes válidos del experimento.

### Sección C — Reclutamiento y calificación

Cómo el fundador sourcea, califica y selecciona los 3 design partners.

#### Channels

En orden de prioridad:

- **Warm introductions** desde advisors, investors y relaciones previas del fundador. La señal de más alta calidad; el intro-er ya vetó el segment fit.
- **La red propia del fundador** (LinkedIn 1st-degree, ex-compañeros, communities en las que está el fundador). Segundo mejor.
- **Cold outreach Stage 1** liftado de [`icp.md`](icp.md) — el cold email segment-específico + el LinkedIn DM copy están ya drafted ahí. La conversión más baja pero el alcance más amplio. No modifiques los templates de icp.md; corren este experimento sin cambios.

Target: 15–25 conversaciones inbound para aterrizar 3 design partners. Planea para una accept rate del ~12% (el cruce segment-fit + disponibilidad + decision-maker overlap es raro).

#### Qualification heuristics

Un candidato es segment-fit si articula al menos UNO de los siete disparadores de compra de [`competitive-positioning.md`](competitive-positioning.md) Section E en sus propias palabras durante la primera conversación:

1. "Nuestra automatización se rompió a las 3am y no pudimos averiguar por qué."
2. "Necesitamos un audit log por acción AI para compliance."
3. "El demo de nuestro agente funciona pero producción se rompe constantemente."
4. "Probamos los error workflows de n8n; no explican nada."
5. "Estamos teniendo sorpresas de costo AI en nuestros flujos."
6. "Nuestra agencia reescribe el mismo recovery glue por cada cliente."
7. "Compliance preguntó quién aprobó esta acción AI."

Descalificadores (lifted de [`icp.md`](icp.md) Stage 2). Un "no" educado, sin excepciones:

- "Aún no estamos lanzando AI a producción." → Etapa equivocada. Vuelve en 6 meses.
- "Queremos una mejor UI de Zapier." → Categoría equivocada.
- "Necesitamos un install on-prem / air-gapped." → Fuera de scope para v1.
- "Estamos evaluando cinco vendors y necesitamos un RFP de 50 preguntas." → Etapa equivocada para un producto en private beta.

#### Intake form template

El formulario va a cada candidato antes de la qualification call. Copy-pasteable a Google Forms / Typeform / Tally / markdown plano. El fundador lee las respuestas antes de la llamada para que la llamada sea la conversación de discovery + selección, no de recolección de data.

```
Janusly private beta — design partner intake

Gracias por el interés. Estamos eligiendo 3 design partners para una private beta de ~8-12 semanas de Janusly — el runtime de flujos AI con una superficie operativa centrada en recovery. Este formulario nos da lo que necesitamos para saber si el fit es correcto; respondemos en 3 días hábiles en cualquier dirección.

1. Nombre de empresa, tu nombre, tu rol, tamaño del equipo.
2. ¿Cuál de estos describe mejor a tu equipo? (elegir uno)
   a) B2B startups with ops workflows (refunds, billing exceptions, escalations, support routing)
   b) Engineering/support teams (incident triage, customer-bug workflows)
   c) AI builders/agencies lanzando flujos AI a clientes
   d) Ninguno de los anteriores (texto libre)
3. ¿Cuál de estos resuena más con tu dolor actual? (multi-select; elige todos los que apliquen)
   - Una automatización se rompió y no pudimos averiguar por qué
   - Necesitamos un audit log por acción AI para compliance
   - El demo de nuestro agente funciona pero producción se rompe constantemente
   - Probamos los error workflows de nuestra herramienta existente y no explican nada
   - Estamos teniendo sorpresas de costo AI en nuestros flujos
   - Reescribimos el mismo recovery glue por proyecto / cliente
   - Compliance preguntó quién aprobó una acción AI y no pudimos responder
   - Ninguno de estos (texto libre)
4. Aproximadamente, ¿cuántas fallas de automatización ve tu equipo por semana hoy? (estimación en texto libre)
5. Cuando algo se rompe, ¿cuánto suele tardar en resolverse? (elegir uno)
   <5 min / 5-30 min / 30 min-2 hr / 2-8 hr / 8-24 hr / >24 hr / no medimos
6. ¿Qué herramienta(s) usas actualmente para el mismo trabajo? (multi-select)
   Zapier / Make / n8n / Workato / Pipedream / Relay / Gumloop / herramienta interna casera / nada todavía / otra (texto libre)
7. ¿Trackeas actualmente Mean Time To Recovery (MTTR) para fallas de workflow? (sí/no, luego texto libre si sí)
8. Elige 3 flujos que correrías en Janusly durante la private beta. Por cada uno, danos una descripción de 1 oración. (texto libre, 3 entradas)
9. Necesitamos una llamada de kickoff de 60 minutos + un check-in semanal de 30 minutos por 8-12 semanas. ¿Estás disponible para esa cadencia? (sí / sí con caveats / no)
10. ¿Tienes constraints de compliance? (multi-select)
    Ninguno / SSO requerido / SCIM requerido / retención de audit-log requerida / on-prem air-gapped requerido / otro (texto libre)
11. ¿Quién decide si tu equipo convierte a Janusly pagado después de la beta? (tú mismo / alguien más — nómbrelos / no estoy seguro)
12. ¿Algo más que deberíamos saber? (texto libre, opcional)

Respondemos en 3 días hábiles. Si somos fit, el próximo paso es una discovery call de 30 minutos.
```

#### Acceptance rubric

Una vez que entran suficientes intakes (target ~15–25), el fundador elige 3. Sesgar hacia:

- **Diversidad de segmento.** Uno por segmento ICP es ideal. Si dos candidatos excelentes están en el mismo segmento, elige el que tiene el dolor más concreto (descripción específica de falla, no genérico "queremos mejores workflows").
- **Decision-maker overlap.** Q11 (tú mismo vs alguien más). Si el usuario no es el comprador, la conversación de contrato en la semana 12 se va a stallear. Prefiere respuestas "tú mismo".
- **Honestidad de disponibilidad.** Q9 "sí" le gana a "sí con caveats". Beta partners que no pueden hacer las llamadas dejan de reportar después de la semana 3.
- **Concreción de workflow.** Los 3 flujos de Q8 deberían estar nombrados y descritos — "procesar refunds cuando dispara un webhook de Stripe" le gana a "corremos automatizaciones". Workflows vagos significan que el partner no sabe qué quiere probar.
- **Honestidad de compliance.** Q10 "air-gapped" → un "no" educado. Q10 "SSO requerido" → sigue siendo fit (lanzamos SSO vía WorkOS hoy per AGENTS.md).

Tres outcomes explícitos de "no" desde la rúbrica:
- Requisito air-gapped.
- "Ninguno de estos" en Q2 Y Q3.
- Usuario-no-comprador (Q11) Y sin path para traer al comprador al kickoff.

#### Pre-kickoff email template

Sale dentro de las 24 horas de la selección. Incluye el calendar invite del kickoff y el link a la encuesta de baseline-MTTR.

```
Subject: Estás dentro — kickoff de la private beta de Janusly

[Name],

Bienvenido a la private beta de Janusly. Elegimos 3 design partners de [N] candidatos; tú eres uno de ellos.

Algunas cosas rápidas:

1. **Llamada de kickoff: 60 minutos.** Calendar invite adjunto para [date/time]. Instalamos Janusly juntos, recorremos el loop de recuperación, y cableamos tu primer workflow en vivo. Para el final de la llamada deberías tener un workflow corriendo y una falla recuperada en el board.

2. **Antes de la llamada, por favor llena la encuesta de baseline.** Son 5 preguntas cortas sobre tu dolor actual de automatización — toma ~10 minutos. Link: [baseline-survey URL]. La necesitamos antes del kickoff para pre-cargar tus specifics.

3. **Lo que necesitamos de ti durante la beta.** Un check-in semanal de 30 minutos por 8-12 semanas (agendamos el slot recurrente durante el kickoff). Un reporte semanal (un formulario corto, ~5 minutos para llenar). Una conversación de willingness-to-pay de 30 minutos alrededor de la semana 6-8. Un exit interview de 45 minutos al final.

4. **Lo que recibes de nosotros.** El fundador (yo) en línea para cada conversación. Acceso completo gratis durante la beta. Influencia directa en la roadmap del producto. Sin compromiso de convertir a pagado — si no funciona, queremos saberlo tanto como queremos que funcione.

5. **Cualquier cosa urgente antes del kickoff** → responde este email o me escribes por DM en [Slack/LinkedIn].

Mirando hacia adelante para trabajar contigo.

[Founder name]
```

### Sección D — Medición de baseline (survey pre-instalación + metodología)

El instrumento que captura el estado "antes de Janusly" del partner. Corre antes de la kickoff call para que el fundador pueda pre-cargar los specifics del partner durante el install.

#### Pre-install baseline survey

Copy-pasteable. Mismo formato de delivery que el intake form (Google Forms / Typeform / Tally / markdown plano).

```
Janusly private beta — baseline survey

Llenas esto antes de la kickoff call. Estimaciones honestas le ganan a números precisos — sabemos que probablemente no medís esto hoy; es exactamente por eso que corremos el experimento juntos.

1. Para cada uno de los 3 workflows que correrás en Janusly durante la beta, danos:
   - Nombre del workflow (corto, e.g. "refund webhook → approval → Stripe").
   - Fuente del trigger (webhook / cron / manual / event de otro sistema).
   - Conteo semanal esperado de runs (estimación aproximada).
   - Tasa de falla esperada hoy (de 100 runs, ¿cuántos fallan?).

2. Para cada uno de los mismos 3 workflows, estima el MTTR ACTUAL (tiempo desde "notamos que una automatización falló" hasta "la falla está resuelta y el workflow puede correr otra vez"). Usa estos buckets:
   < 5 min  /  5-30 min  /  30 min - 2 hr  /  2-8 hr  /  8-24 hr  /  > 24 hr

3. Para cada workflow, describe las últimas 3 fallas conocidas que recuerdes (1-2 oraciones cada una, descripción del partner en sus propias palabras). Ejemplo: "El webhook de Stripe devolvió un 401 porque la API key rotó y nadie actualizó el env var."

4. Aproximadamente, ¿cuántas horas-ingeniero por semana gasta tu equipo en toil de automatización hoy? (Toil = triage manual de fallas, reintentos manuales, re-run manual de workflows rotos, paperwork alrededor de incidentes.) Estimación en texto libre, no se necesita número preciso.

5. Termina esta oración: "Janusly valdría la pena pagarlo obviamente si ___." Una oración, en las propias palabras del partner.
```

#### Measurement methodology

Lo que el fundador usa internamente para derivar los números publicados.

**Baseline MTTR (el número "antes").**
- Source: Pregunta 2 de la encuesta de baseline (self-reported del partner, bucketed).
- Coding: cada bucket recibe un midpoint para aritmética (`<5min` → 3 / `5-30min` → 17 / `30min-2hr` → 75 / `2-8hr` → 300 / `8-24hr` → 960 / `>24hr` → 2880, en minutos).
- Aggregation: la mediana a través de los 3 workflows del partner es el baseline partner-level; la mediana de 3 baselines partner-level es el baseline cohort-level.
- **Esto es data blanda.** Self-reported, basada en memoria, no medida. El reporte publicado la nombra como data blanda con los rangos del estimado del partner mostrados al lado.

**Post-install MTTR (el número "después").**
- Source: el runtime mismo. Para cada falla post-instalación, la métrica actual de recovery de Janusly es `dead_letters.replayed_at` − `dead_letters.created_at` para filas con `status = "replayed"` (la misma shape que usa `GET /recovery/metrics` después de que `POST /dlq/replay` estampa la fila de DLQ tras un patch validado en sandbox).
- Aggregation: mediana a través de todos los runs de recovery observados por partner; mediana de 3 medianas partner-level es el MTTR post-install cohort-level.
- **Esto es data dura.** Capturada desde timestamps del runtime, con `run_events` disponible como timeline de soporte para la acción de recovery. El reporte publicado la nombra como data dura.

**El delta antes/después.**
- `mediana baseline (blanda)` menos `mediana post-install (dura)` por partner.
- Delta del cohort: mediana de 3 deltas de partner.
- Este es el número headline del reporte publicado. La sección de metodología nombra explícitamente la asimetría (blanda → dura) para que un lector pueda interpretar el número sin overclaim.

**Setup friction.**
- Source: kickoff call (Sección E). Checklist al final de la llamada — ¿pegamos el target de 60 minutos "primer recovered run"?
- Coding: pass / partial-pass (recovered run aterriza en semana 1, no en el kickoff) / fail (recovered run no aterriza en semana 1).
- Aggregation: 3-de-3 / 2-de-3 / 1-de-3 / 0-de-3 partners llegan al bar de pass.

**Willingness to pay.**
- Source: conversación de la Sección G, semana 6–8.
- Output: banda per-partner por métrica de valor (per-seat / per-recovered-run / per-AI-call / otra). NO un número único — una banda.
- Aggregation: patrón cross-partner, no mediana aritmética (3 data points no es suficiente para una mediana; nombramos el patrón).

#### Failure-category coding scheme

Cada falla observada (en los workflows del partner durante la beta) se bucketiza usando el `ErrorCategory` union propio del engine (`packages/shared/src/error-signature.ts`). El histograma de categorías del reporte publicado mapea 1:1 a la engineering reality — sin categorías acuñadas por marketing.

Los 7 categorías cerradas:

- `secret_missing` — referencia de credencial faltante o inválida (e.g. `BILLING_API_KEY` sin asignar, template `{{secret.X}}` referenciando un nombre que no existe).
- `http_error` — respuesta non-2xx de un nodo HTTP o tool HTTP-using (4xx o 5xx; el engine no las separa en la signature hoy).
- `network_timeout` — request nunca completó (sin respuesta dentro del timeout configurado).
- `ai_provider` — el provider de LLM devolvió un error (quota, rate, output malformado, modelo desconocido).
- `parse_error` — output no se pudo interpretar (JSON.parse tiró, la validación de Zod rechazó).
- `tool_input` — el tool fue llamado con input inválido (campo requerido faltante, type mismatch).
- `unknown` — todo lo demás (el engine no pudo clasificar).

El fundador registra cada falla en el experiment notebook con `{ partnerId, workflowName, runId, category, failureSignature, recoveryActionTaken, MTTR_minutes }`. El reporte publicado muestra histogramas per-partner y per-cohort a través de estas 7 categorías.

### Sección E — Onboarding (script de kickoff de 60 minutos)

La primera llamada con cada partner. Meta: al minuto 60, el partner tiene Janusly corriendo localmente, un workflow cableado, un run exitoso en el board, y una falla recuperada en la timeline. Si fallamos el bar de 60 minutos, la métrica de "setup friction" de la Sección B registra un partial-pass para ese partner.

#### Pre-call setup (checklist del fundador)

- Las respuestas de intake + baseline survey del partner están abiertas en otra pestaña.
- El recording script de `failed-workflow-recovery` ([`docs/marketing/recording-scripts/failed-workflow-recovery.md`](recording-scripts/failed-workflow-recovery.md)) está abierto como demo backbone.
- El comando `pnpm seed:demos` (de ENG-069) está listo para correr en la máquina del partner vía screen-share.
- Recording está encendido (con consentimiento del partner — pregunta en el primer minuto).

#### Minute-by-minute script

**Minutos 0–5: Context-set.**

Talking points (lift verbatim, adapta al nombre del partner y respuestas Q2/Q3):

> "Contexto rápido antes de instalar nada. Janusly está construido alrededor de una tesis simple: recovery, no conteo de integraciones, es la cuña. Las workflow tools fueron construidas para la era de las integraciones — connectors drag-and-drop. No fueron construidas para la pregunta 'qué pasa cuando el modelo devuelve nonsense, el secret expira, o un paso que funcionó ayer falla hoy?' Esa es la pregunta para la que construimos.
>
> Lo que hacemos hoy: instalamos Janusly juntos, recorremos el loop de recuperación en un template demo, después cableamos tu primer workflow real. Para el final de esta llamada deberías tener un workflow corriendo y una falla recuperada en el board. Ese es el target de 60 minutos.
>
> Lo que medimos durante la beta: Mean Time To Recovery para tus workflows reales. Ya tenemos tu baseline survey (el número self-reported de antes de hoy); medimos el MTTR post-instalación desde el runtime mismo. Ese es el experimento. ¿Suena bien?"

**Minutos 5–15: Install.**

Camina al partner por el Quick-start del README, condensado:

1. `git clone` Janusly + `pnpm install`.
2. Setea environment: `ANTHROPIC_API_KEY` (el partner pega la suya o usa modo BYO key). Auth en dev-mode no necesita setup adicional cuando Supabase está sin setear y `NODE_ENV !== "production"`; los headers `x-org-id: default` y `x-user-id: dev-user` ridean automáticamente desde la web.
3. `pnpm dev` levanta Postgres + Redis + Ollama vía Compose, corre migrations, después arranca api + worker + web en http://localhost:5173.
4. En una segunda terminal, `pnpm seed:demos` escribe las tres credenciales canónicas de demo (idempotente — no-op si ya existen; `pnpm seed:demos -- --force` reinicia según ENG-069).
5. Abre http://localhost:5173.

**Friction watchpoints (el fundador narra en voz alta mientras el partner corre los comandos):**
- Node 24 requerido (revisa `node --version`). Node más viejo → `nvm use 24` o `corepack enable`.
- Docker requerido. Si el partner no tiene Docker → marca setup como `partial-pass` para la métrica de friction; pueden completar localmente con su propio Postgres + Redis pero no es un path de 60 minutos.
- Anthropic key no seteada → las superficies AI degradan a fallback determinístico per AGENTS.md; el loop de recuperación funciona estructuralmente igual pero `POST /ai/explain-run` y `POST /ai/patch-workflow` devuelven `mode: "fallback"`. Documenta esto en las notas de friction.

**Minutos 15–25: Walkthrough del loop de recuperación en el template demo.**

Sigue el recording script de `failed-workflow-recovery`. Los beats:

1. Abre el template `failed-workflow-recovery` en AI Studio.
2. Guárdalo, córrelo con el sample payload, y deja que la falla intencionalmente sin asignar `{{secret.BILLING_API_KEY}}` aterrice en DLQ.
3. Abre el home del Centro de Recuperación; clickea el run fallido y muestra la causa raíz explicada por AI desde `POST /ai/explain-run`.
4. Abre la recovery dialog; muestra las 1–3 patch suggestions de `POST /ai/patch-workflow` con confidence + approachLabel.
5. Elige primero la suggestion estructural de approval. Clickea "Apply & validate" — `POST /dlq/validate-fix` corre el sandbox replay (writes-skipped per el dryRun gate de AGENTS.md). Sava la nueva versión.
6. Re-corre el flujo parchado, aprueba el nuevo human gate, y deja que el secret aún sin asignar falle otra vez.
7. Re-abre la recovery dialog, elige la suggestion `swap_secret_ref`, valida el patch, y sava la siguiente versión.
8. Para un cierre en verde-en-vivo, cablea el secret de reemplazo + endpoint sandbox de billing alcanzable, después clickea "Replay" vía `POST /dlq/replay`. Mira el workflow correr hasta verde.

Prompt de observación del partner: "Camíname por lo que acabas de ver — ¿qué es diferente del failure path de tu herramienta actual?"

**Minutos 25–45: Primer workflow real.**

El partner elige el más simple de los 3 workflows de Q8 del intake. El fundador co-pilotea mientras el partner cablea.

- New workflow → nombre de Q8 del intake.
- Agrega el nodo de trigger (webhook / cron / manual según Q8 del intake).
- Agrega los nodos de trabajo (HTTP / AI / tool steps).
- Sava la primera versión.
- Corre una vez exitosamente (el fundador ayuda a ajustar el test trigger payload si hace falta).
- **Rómpelo intencionalmente.** Rota la credencial. Inyecta un 401. Dropea un campo requerido del trigger payload. La rotura debería coincidir con la shape de falla de Q3 del baseline survey ("las últimas 3 fallas") si es posible.
- Abre el Centro de Recuperación → el propio workflow del partner aterriza en DLQ.
- Camina por recovery: explain → patch → sandbox → apply → replay. El partner clickea; el fundador narra.

**Minutos 45–55: Sus otros 2 workflows.**

El partner nombra los 2 restantes de Q8 del intake. No los cableamos en vivo hoy — el partner se compromete a cablear el workflow #2 para el final de la semana 1 y el workflow #3 para el final de la semana 2. El fundador ofrece una sesión de wiring de 30 minutos si el partner se bloquea.

**Minutos 55–60: Acuerdo de cadencia semanal.**

- Elige el slot recurrente de 30 minutos (misma hora cada semana por 8–12 semanas).
- Confirma la cadencia del weekly report (el partner llena el reporte para Friday EOD; el fundador lee antes de la llamada recurrente).
- Setea el canal de comunicación para friction entre-meetings (canal de Slack / Discord / email thread — preferencia del partner).
- Menciona la conversación de willingness-to-pay en semana 6–8 ("una conversación de 30 minutos sobre pricing — discovery, no negotiation").
- Menciona el exit interview en semana 12 ("cierre de 45 minutos, capturamos lo que aprendimos juntos").

#### Setup checklist (definición de "ready" al final del kickoff)

La kickoff call cuenta como un `pass` en la métrica de setup-friction si al minuto 60 TODO lo siguiente es verdadero:

- [ ] `pnpm dev` corriendo localmente (api + worker + web en http://localhost:5173).
- [ ] Auth en dev-mode funcionando (el endpoint `/workflows` devuelve 200 con la org default).
- [ ] Al menos un workflow cableado (el del partner, de Q8 del intake).
- [ ] Al menos un run exitoso en ese workflow.
- [ ] Al menos una falla recuperada en el mismo workflow (o el template demo si el workflow del partner no se pudo romper limpiamente de forma intencional).
- [ ] Slot de cadencia semanal acordado y en el calendario.

`partial-pass` = el workflow del partner se cablea para el final de la semana 1 (no al minuto 60). `fail` = el workflow del partner no se cablea para el final de la semana 1.

#### Hand-off email template

Dentro de las 24 horas del kickoff:

```
Subject: Recap del kickoff de Janusly + plan de semana 1

[Name],

Gran kickoff. Recap rápido y el plan de semana 1:

Lo que está seteado hoy:
- Janusly corriendo localmente vía `pnpm dev`
- Workflow [#1 name] cableado, [N] runs exitosos, [M] falla(s) recuperada(s)
- Anthropic key configurada (o: degradando a fallback — está bien para el loop de recuperación estructural)

Plan de semana 1:
- Cablear workflow [#2 name] para [Friday date]
- Llenar el weekly report en [link]
- Llamada recurrente: [day/time] empezando [next week date]

Recursos que vas a necesitar:
- README Quick-start (install de Janusly): [link al anchor del README]
- Recording del loop de recuperación: [link a recording-scripts/failed-workflow-recovery.md]
- Canal de Slack para friction: [link]

Si algo te bloquea mid-week, mándame DM por Slack — respondo dentro de 4 horas hábiles. Bloqueadores serios: llamada el mismo día.

Hablamos pronto.

[Founder name]
```

### Sección F — Cadencia semanal

El ritmo durante las semanas 2–10. Llamada recurrente + reporte semanal + protocolo entre-meetings.

#### Standing 30-minute call agenda

Misma estructura cada semana. El partner sabe qué esperar; el fundador no tiene que re-explicar el formato.

- **Minutos 0–5: Wins / friction liderados por el partner.** El partner camina por lo que funcionó y lo que no desde la semana pasada. Open-ended; el fundador escucha, no interrumpe a menos que le pregunten.
- **Minutos 5–15: Walk del runtime liderado por el fundador.** El fundador pone la timeline de runs del workflow del partner en screen-share: entradas de DLQ, acciones de recovery tomadas, MTTR observado esta semana. El fundador lee los números; el partner reacciona.
- **Minutos 15–25: Próximo paso.** Elige qué cablear / arreglar / explorar a continuación. Puede ser un nuevo workflow, un nuevo node type, un nuevo feature (loop de feedback de recovery, cluster apply, rollback de versión). El fundador opcionalmente camina por una nueva superficie de producto en 5 minutos si es relevante.
- **Minutos 25–30: Cierre.** Confirma la fecha de la próxima llamada. Confirma cualquier homework (e.g. "llenas el weekly report para Friday"). Canal de Slack para friction.

#### Weekly-report template

El partner lo llena para Friday EOD antes de la próxima llamada recurrente. Copy-pasteable en la misma herramienta de formularios que se usó para el intake.

```
Janusly weekly report — semana del [date]

1. Workflows agregados o removidos esta semana:
   (Texto libre. E.g. "Agregué 'churn-risk-followup' el martes. Removí 'old-refund-v1' — reemplazado por 'refund-triage-v2'.")

2. Total runs esta semana, por workflow:
   (Conteos aproximados. Puedes leerlos de `GET /runs` o ojear el dashboard.)

3. Failures esta semana, por workflow:
   (Conteos aproximados. Entradas de DLQ + run nodes fallidos.)

4. Recovery actions taken:
   - Patch suggestions accepted: [N]
   - Patch suggestions rejected: [N]
   - Sandbox validation runs: [N]
   - Production replays: [N]
   - Version rollbacks: [N]

5. MTTR observado esta semana, por workflow:
   (Por cada workflow donde corriste un recovery: minutos estimados de falla a recovered replay. No te preocupes por la precisión; rangos están bien.)

6. Friction worth naming (1-3 items):
   (Texto libre. Cualquier cosa que te frenó, te confundió, o se sintió clunky. Incluso "la dialog tomó 3 clicks en lugar de 1" es señal útil.)

7. Surprise of the week:
   (Una oración. Cualquier cosa que Janusly hizo esta semana que no esperabas — positiva O negativa. Aprendemos más de estas.)

8. Confianza en continuar la beta (1-5):
   (Solo desde semana 2 en adelante. 1 = "estoy considerando dejar la beta." 5 = "estoy adentro hasta el final.")
```

#### Founder's internal experiment notebook

Por partner-semana, el fundador registra:

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

Mantén esto en un archivo markdown o spreadsheet — una fila por (partner, semana). El reporte publicado agrega desde estas filas.

#### Between-meeting protocol

- **Canal de Slack por partner (o canal compartido #janusly-beta si los 3 partners están cómodos estando en la misma sala).** El fundador responde dentro de 4 horas hábiles durante el día de trabajo.
- **Bloqueador serio = llamada el mismo día.** Definición de "serio": el partner no puede correr su workflow, el partner está considerando dejar la beta, el equipo de compliance del partner levantó una preocupación. Cualquier otra cosa puede esperar la llamada recurrente.
- **Bug encontrado en Janusly = abre un issue.** El fundador hace triage y o arregla inline (política de collateral fix) o crea un ticket. El partner no tiene que esperar — el workaround sale del fundador el mismo día.
- **Friction worth telegraphing = nómbrala en el weekly report.** El item 6 de la Sección F es el canal estructurado para friction non-blocking.

### Sección G — Conversación de willingness-to-pay

El instrumento de discovery de pricing. Correr entre las semanas 6 y 8 una vez que el partner haya experimentado el loop de recuperación resolviendo una falla real al menos una vez. Atado al "plan de release de pricing" de [`pricing.md`](pricing.md) Section G — esta conversación produce la data que convierte los candidatos de métrica de valor de pricing.md en números v1.

#### Pre-conditions

No corras esta conversación hasta que LAS tres se sostengan:

- [ ] El partner ha aceptado al menos 3 patch suggestions en producción vía el Centro de Recuperación.
- [ ] El MTTR delta es observable en al menos uno de los workflows del partner (mediana post-instalación < mediana self-reported de baseline).
- [ ] El partner ha experimentado el loop de recuperación resolviendo una falla real (no-demo) al menos una vez.

Si cualquier condición falta en semana 6, posponer a semana 7 u 8. Si sigue faltando en semana 8, corre la conversación pero nota en el reporte publicado que la señal de WTP de este partner es más débil (menos valor experimentado = menos habilidad para ponerle precio).

#### Format

**Conversación de 30 minutos, NO un Typeform.** Los números vienen de hablar, no de un slider. El fundador agenda una llamada dedicada, la enmarca como discovery (no negotiation), y deja que la conversación respire.

#### Opening frame (lift verbatim)

> "La llamada de hoy es diferente del check-in semanal. Vamos a hablar de pricing — pero es discovery, no negotiation. No te voy a cotizar un precio; no me vas a dar uno. Lo que quiero es tu lectura honesta de lo que vale Janusly para tu equipo. La data de esta conversación, combinada con la misma conversación de los otros dos design partners, es lo que vamos a usar para setear el pricing v1. Así que tus respuestas dan forma a lo que ven otros clientes — no a tu factura. ¿Suena bien?"

#### Question script (open-ended; la conversación va a donde tiene que ir)

1. **Replacement difficulty.** *"Lectura honesta: si Janusly desapareciera mañana, ¿cuál es el plan de tu equipo?"*
   - Escucha por: "lo construiríamos nosotros mismos" (WTP alto — valoran el engineering ya hecho) / "volveríamos a [tool]" (WTP medio — valoran el upgrade pero tienen un fallback) / "viviríamos sin esto" (WTP bajo — re-examinar el valor).

2. **Value metric preference (sin priming).** *"Si te dijera que vamos a cobrar por esto, ¿cuál es la primera métrica por la que querrías pagar — seats, recovered runs, AI calls, otra?"*
   - **No listes las métricas primero.** Deja que las propongan. Después indaga: "¿Por qué esa? ¿Qué hay de las otras?"
   - Los tres candidatos de [`pricing.md`](pricing.md) Section D son: per-seat, per-recovered-run, per-AI-call. Si nombran otra cosa, escríbela verbatim — es nueva señal para el reporte.

3. **Unit value derivation.** *"Caminame por la matemática: ¿cuánto vale un single recovered run para tu equipo en minutos-ingeniero? Hace cuenta servilleta y dale en dólares."*
   - Escucha por: su engineer-cost por hora × MTTR-ahorrado-por-recovery. Esto es la unit-economics propia del partner; el fundador no la suministra.

4. **Price bands (no points).** *"¿Cuál es la banda en la que renovarías sin una escalation interna? ¿Cuál es la banda donde necesitarías ir a un dueño de presupuesto?"*
   - **Siempre rangos, no puntos exactos.** Un punto ("$1500/mes") se siente como negotiation; un rango ("renovar bajo $2k, escalar arriba de $5k") se siente como discovery. El reporte publicado agrega rangos.

5. **Competitive anchor.** *"Si estás pagando por [Zapier / n8n / Make / lo que sea que nombraron en Q6 del intake], ¿cuánto pagas hoy, y por qué?"*
   - Ancla la intuición de precio del partner. Frecuentemente el data point más útil — el partner conoce la factura de su herramienta existente mejor de lo que conoce qué "debería" costar una nueva.

6. **Billing cadence.** *"¿Contrato anual o mensual? ¿Por qué?"*
   - Escucha por: preferencias de ciclo de presupuesto. Frecuentemente "anual pero con facturación trimestral" o "mensual hasta que confiemos, anual después."

7. **Commitment lever.** *"Si te pedimos un commit de 12 meses al extremo bajo de tu banda, ¿qué quisieras a cambio?"*
   - Saca a flote el palanca discount-por-commitment para futuros términos de deal. Escucha por: % de descuento, white-glove onboarding, feature custom, TAM nombrado.

#### What the founder captures

Por partner, un formulario llenado en el experiment notebook:

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

#### What we never do in this conversation

- **Cotizar un precio.** El instrumento es discovery, no negotiation. La respuesta existente de pricing.md Section G — *"trabajaremos con tu equipo sobre el precio una vez que ambos conozcamos el workload"* — sigue siendo la respuesta si el partner pregunta.
- **Prometer un descuento.** Los términos de descuento vienen después, en el handoff exit-interview-to-paid o más tarde.
- **Mostrarle pricing.md al partner.** Ese doc es contexto interno de ventas, no collateral de cliente.
- **Comparar rangos entre partners durante la llamada.** Cada partner recibe una conversación fresca. La comparación cross-partner ocurre internamente en el reporte publicado.

### Sección H — Exit interview (cierre de 90 días)

Final de la beta. El momento conversion-o-churn + captura de permisos para todo lo que queremos usar externamente.

#### Pre-meeting prep

48 horas antes de la llamada de exit, el fundador le manda al partner un resumen de 1 página de la observación de los 90 días. El partner lo lee antes de la llamada para que la llamada sea reacción + permisos + decisión, no presentación de data.

El template del resumen:

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

#### 45-minute call agenda

- **Minutos 0–10: Revisión del summary.** El fundador camina por el resumen. El partner corrige cualquier cosa que tergiverse su experiencia. Sesgo hacia escuchar sobre defender — la lectura del partner sobre la data es más importante que la nuestra.

- **Minutos 10–20: Case study.** *"Si un amigo en otra empresa te preguntara sobre Janusly hoy, ¿qué le dirías?"* Escucha por el summary de 1-2 oraciones que daría el partner. Pregunta: *"¿Puedo citarte en eso? ¿Con o sin tu nombre? ¿Con o sin el número?"* — captura el permiso de case-study inline.

- **Minutos 20–30: Decisión de conversion.** *"¿Qué tendría que ser verdad para que conviertas a un Janusly subscription pagado? Precio, feature, términos de contrato, compliance — ¿cuál es el gate?"* Escucha por: banda de pricing (la WTP de la Sección G debería coincidir), gap de feature (nombrado explícitamente), requerimiento de contrato (SSO / SCIM / DPA / SOC2), o "estamos in, solo manda el contrato."

- **Minutos 30–35: Trigger de churn.** *"¿Qué tendría que ser verdad para que dejes Janusly? Honesto, en tus propias palabras."* Esta es la respuesta más importante de la llamada. Escríbela verbatim.

- **Minutos 35–40: Asignación de presupuesto.** *"Si tuvieras $[X — la banda baja de su banda de la Sección G] ahora mismo para gastar en workflow tools, ¿cómo lo dividirías entre vendors? Janusly, [su herramienta existente], cualquier otra."* Escucha por: % de asignación. Un partner que pondría 100% en Janusly es un convert; 50/50 es coexist; <25% significa que somos un complemento, no un reemplazo.

- **Minutos 40–45: La pregunta "qué deberíamos haber preguntado".** *"¿Algo que deberíamos haber preguntado y no preguntamos?"* Frecuentemente la pregunta más valiosa de la llamada. Free-form.

#### Permission capture (explícito, escrito, en la llamada)

Lee cada prompt en voz alta, captura la respuesta sí/no/anonimizada del partner verbatim. Manda un summary escrito dentro de las 24 horas para que el partner lo confirme por reply (protección legal para uso downstream en marketing). **Las 5 líneas de permiso adentro del bloque de código se quedan verbatim en inglés** — son consentimientos legales firmados en inglés.

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

#### Conversion-or-churn outcome

Cada exit interview termina con uno de tres outcomes. El reporte publicado nombra cuáles 3 de 3 ocurrieron. Los tres son outcomes válidos del experimento.

- **Outcome A: Convert.** El partner dice "estamos in." Handoff: manda un draft de contrato de 30 días dentro de las 48 horas, con términos anclados en la banda declarada de la Sección G. Si quieren un commit de 12 meses, aplica el lever de la pregunta 7 de la Sección G. Agenda la llamada kickoff-to-paid.
- **Outcome B: Coexist.** El partner se queda en el tier gratuito sin commit pagado inmediato pero sin churn tampoco. Relación ongoing, sin contrato. Agenda un check-in trimestral para revisitar.
- **Outcome C: Churn.** El partner no convierte y no continúa. Captura la respuesta del trigger de churn de los minutos 30–35 — eso es oro para el próximo experimento. Manda un email de agradecimiento + ofrecimiento de mantenerse en contacto.

### Sección I — Plantilla de reporte de beta privada

El deliverable nombrado en el AC de ENG-093: *"publicar un reporte de beta privada que decida si el Centro de Recuperación permanece como product home primario."*

#### Format

Publicación internal-first. Vive en `docs/marketing/private-beta-report.md` (creado por el trabajo FUTURO de ENG-093; este playbook entrega solo el template, no el reporte populado). La publicación externa (blog post, landing page de case study, deck) es downstream una vez que los permisos de Sección H se capturan.

#### Required sections (the skeleton)

1. **Executive summary.** Tres números y una oración de verdict.
   - **MTTR delta (mediana del cohort):** [N] minutos baseline → [N] minutos observed = [%] mejora.
   - **Success-criteria hits:** [3 / 3] o [2 / 3] o [1 / 3] partners pegaron los tres criterios de éxito de la Sección B.
   - **Willingness-to-pay aggregate band:** [low – high] per [value metric].
   - **Verdict:** *"El Centro de Recuperación permanece como product home primario; sigue la recomendación de pricing v1."* O *"Re-posicionamos antes de pricing; esto es lo que aprendimos."*

2. **Cohort description.** 3 partners, nombrados o anonimizados según los permisos de la Sección H. Por cada uno: segmento ICP, tamaño de empresa, shape de workflow primario, cita de dolor de 1 oración.

3. **Methodology.** Liftada verbatim de la Sección D de este playbook. El reporte cita el playbook para metodología en lugar de re-establecer todo el asunto.

4. **Findings per partner.** Por cada uno de los 3 partners, una subsección de 1 página:
   - Baseline MTTR (self-reported, data blanda, rango mostrado).
   - Post-install MTTR (engine-measured, data dura, mediana mostrada).
   - Failure-category distribution (el histograma de 7 categorías de la Sección D).
   - Patch-suggestion accept rate (del experiment notebook).
   - Willingness-to-pay band (output de la Sección G).
   - Cita verbatim de 1 oración (con permiso de la Sección H).
   - Outcome: convert / coexist / churn.

5. **Cross-partner aggregate.** Los tres números del executive summary, con su derivación explicada. Muestra los inputs per-partner que alimentaron las medianas del cohort. Honestidad sobre N pequeño (3 data points; nombramos patrones, no significancia estadística).

6. **Wedge verdict.** ¿Dice la data:
   - "El Centro de Recuperación permanece como product home" (criterios de éxito de la Sección B cumplidos: ≥ 2 de 3 partners + ≥ 2 de 3 señales WTP + ≥ 2 de 3 setup friction passes)?
   - O "Re-posicionamos antes de pricing" (cualquiera de los criterios de falla de la Sección B disparado)?

7. **v1 pricing recommendation.** Métrica de valor específica (per-seat / per-recovered-run / per-AI-call / otra si la data sacó a flote una) + banda recomendada (low – high) + preferencia de cadencia de billing + shape del commitment-lever. Alimenta hacia adelante al trigger de pricing.md Section G de "Después de que ENG-093 cierre".

8. **Open questions.** Lo que los 90 días no resolvieron. Candidatos para el próximo experimento (un segundo cohort, un deep-dive de un solo segmento, un run de feature-gap-validation, etc.). Honestidad sobre el límite de tamaño del cohort.

9. **Permissions ledger.** Por partner, por tipo de artefacto, qué consentimiento se capturó. La referencia para cada uso externo de data de la beta downstream (landing page de case study, charla de conferencia, slide de ventas).

#### Publication cadence

- **Semanas 13–14:** draft del reporte interno. El fundador escribe; agrega desde el experiment notebook. Cross-check con cada partner antes de la publicación externa (el partner ve la sección sobre él primero).
- **Semanas 15–18:** versión externa publicable. Anonimizada según necesidad per la Sección H. Vive en el mismo path; una variante `external/` strippea detalles identificatorios.
- **Post-publicación:** logos / case studies / materiales de conferencia siguen el permiso individual del partner. Cada artefacto externo referencia el permissions ledger del reporte.

### Sección J — Checklist operacional (cheat sheet "qué corre esta semana")

Un summary scan-friendly que el fundador mantiene abierto durante la beta. Mismo rol que [`pricing.md`](pricing.md) Section I juega para ventas.

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

El fundador actualiza esto cada lunes a la mañana antes de las llamadas recurrentes de la semana.

### Sección K — Fuera de scope (lo que este playbook NO cubre)

- **Correr el experimento mismo.** Esto es el manual de instrumentos. Correrlo es trabajo operacional del fundador — reclutar, agendar, sostener las llamadas, registrar el notebook, escribir el reporte.
- **Artefactos externos publicables.** Blog post, charla de conferencia, landing page de case study, slides de sales deck — todo downstream una vez que los permisos de la Sección H se capturan.
- **Documentación de compliance vendor-grade.** Atestaciones SOC2, templates de DPA, librerías de security questionnaires — work stream diferente. Usa AGENTS.md internamente como source of truth operativo si un partner pregunta, pero no lo mandes como collateral de cliente y no draftees docs de compliance adentro de este playbook.
- **Per-region / per-locale recruitment.** El reclutamiento corre en inglés en v1 (el fundador es dueño del experimento en inglés; los partners corren workflows reales en inglés). Los instrumentos localizados al español están en este bloque `Versión en español` que estás leyendo — operadores del lado del fundador que prefieren español pueden leer cada instrumento en su idioma. Las reglas de voz de marca de `narrative.md` aplican por igual a ambos idiomas.
- **Automatización del experiment notebook.** El fundador mantiene el notebook a mano (archivo markdown o spreadsheet). Una UI bespoke de "dashboard de private-beta" está fuera de scope — el experimento es muy chico (3 partners × ~12 semanas) para justificar tooling.
- **Multi-cohort runs.** Esto es el playbook para el PRIMER cohort de 3 partners. Si corremos un segundo cohort (un pase de ajuste con segmentos diferentes, un run de feature-gap-validation, una expansión regional), el playbook gana una nueva sección entonces — pero el path v1 es un cohort, una publicación, una decisión de pricing v1.
- **Modificar el AC de ENG-093.** Este playbook HABILITA ENG-093; no redefine el AC. ENG-093 sigue Pending en el ROADMAP hasta que el experimento corra y produzca un reporte.

### Sección L — Cross-references (tabla de reverse-links)

Para lectores futuros navegando de vuelta desde este playbook a sus consumidores downstream:

| Sección en este playbook | Consumida por |
| --- | --- |
| Sección B success criteria + verdict | [`pricing.md`](pricing.md) Section G ("After ENG-093 closes") |
| Sección C qualification heuristics | [`competitive-positioning.md`](competitive-positioning.md) Section E (the 7 buying triggers) |
| Sección C intake form Q2 (segment self-id) | [`icp.md`](icp.md) (the 3 canonical segments) |
| Sección D failure-category coding scheme | `packages/shared/src/error-signature.ts` (the 7-value `ErrorCategory` enum) |
| Sección D measurement methodology | The published private-beta report (Sección I) |
| Sección E demo backbone | [`recording-scripts/failed-workflow-recovery.md`](recording-scripts/failed-workflow-recovery.md) |
| Sección G WTP conversation output | [`pricing.md`](pricing.md) Section G (v1 number selection) |
| Sección H permission capture | [`landing-page.md`](landing-page.md) trust-strip (permiso de logo), landing page de case study (futuro) |
| Sección I published report | [`pricing.md`](pricing.md) Section G (trigger "After ENG-093 closes"), futuro blog post / charla de conferencia |

Cada consumidor downstream que existe hoy está listado. Los consumidores futuros (landing page de case study, blog post) se agregan a esta tabla cuando salen.
