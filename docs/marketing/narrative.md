# Janusly brand narrative

The single source of truth for how Janusly sounds when we talk about ourselves. Marketers, founders, and anyone pitching Janusly should lift sections from here verbatim instead of inventing new copy.

This is the **brand-voice register** of what `README.md` and [`docs/PLAN.md` §16.0](../PLAN.md) say in the technical and strategic registers. Same product. Same anchors. Different audience.

## Category

**Self-healing AI workflow operator.**

Janusly is not another automation builder. It is the **operating layer** for AI workflows in production — the place where a workflow that fails at 3am gets explained, recovered, reviewed, and replayed without paging anyone. Same surface area as a database administrator, but for the AI-driven business processes that increasingly run a company.

## Primary tagline

> **AI workflows that explain, recover, and safely evolve.**

Alt taglines, by context:

- **Landing hero:** *"The operational backbone for AI workflows."* — Punchy, category-defining, one line.
- **Sales call open:** *"Trust AI workflows in production — observable, recoverable, reviewable, auditable."* — The elevator. Lands the anchor phrase the buyer remembers.
- **Conference badge / podcast intro:** *"We make AI workflows feel less like fragile demos and more like production infrastructure."* — Names the pain the audience has felt.
- **Demo deck closer:** *"Mean Time To Recovery: from hours to minutes, from minutes to seconds."* — The metric, said plainly.

## One-sentence pitch

> **Trust AI workflows in production** — observable, recoverable, reviewable, auditable. Janusly is the operating layer for the AI-driven business processes that matter.

If you have ten seconds, this is the line.

## Anti-positioning

We are deliberate about what we are **not** because the workflow-automation category is crowded and confused. Saying "not Zapier" up front saves the buyer five minutes of mental sorting.

- **Not a "better Zapier UI."** Recovery, not integration breadth, is the wedge. Zapier wins when the question is "how many SaaS apps can I connect?" Janusly wins when the question is "what do I do when one of them breaks at 3am?"
- **Not "n8n with AI."** AI is part of the engine — the patch-suggestion path, the explain-run path, the multi-agent primitive — not a button glued on top of a visual builder.
- **Not generic RPA.** We operate AI workflows. We do not click-record desktop scripts. The runtime is a DAG, not a screen-recorder.
- **Not "agents that do everything."** Human approval gates and the recovery dialog are first-class primitives. The operator stays in the loop. The AI proposes; the human decides.

Anti-positioning is not snark. It is **respect for the buyer's time** — we tell them quickly what we are not, so they can decide just as quickly whether we are what they need.

## Product principles

The bets the product is built on, in brand voice. Each one names what the operator sees, not the route path behind it.

- **Observe every run.** A workflow should leave enough structured evidence for any operator to understand what happened — when, where, by whom, with what input, in what duration, with what cost. We treat the run timeline + audit log as first-class product surfaces, not engineering exhaust.
- **Explain every failure.** A failed step should produce a clear root cause, an owner, and a recovery path. The system speaks plain English about what broke and what to try next — no log archaeology required.
- **Recover safely.** AI can suggest the fix, but production changes must be **reviewable, sandboxed, auditable, and reversible**. Every patch is a proposal the operator reviews and applies; the sandbox proves the patch works before it touches real systems; the new version saves; the old version is one click away.
- **Improve over time.** Every accepted or rejected fix should teach the operator loop how *this* business wants to run. The product learns the team's tolerance for risk, their preferred recovery patterns, their MTTR baseline — and the recommendations adapt.

These are the four ways Janusly earns the right to be the platform you put critical AI workflows on top of. **Observable, recoverable, reviewable** is the three-word version we repeat.

## Demo story (the 3am moment)

It's 3am. The on-call engineer's phone buzzes. The billing flow has failed — the third one this week.

They open their laptop, expecting the usual ritual: log into the dashboard, dig through stack traces, find the broken step, ping the platform team, file a ticket, hope to get back to sleep by 4. Half an hour, minimum. Maybe an hour.

Tonight, the dashboard is Janusly. They see the failed run at the top of the Recovery Queue. They click into it. The system has already written, in plain English, what went wrong: *"The billing API call failed because the BILLING_API_KEY secret is unbound for this org. The call is also write-side and has no human approval gate upstream — which is why this kind of failure should not have been able to silently happen in the first place."*

The engineer reads two suggestions. The first is structural — insert an approval node before the billing call so this can't fire blindly again. The second is the immediate fix — swap the secret to the one the operator already has bound. They click **Apply & validate**. Janusly runs the patched workflow in a sandbox, without touching the real billing system, and confirms it would have worked. They click apply, approve the held run, and watch it run through to green.

It's 3:04am. The engineer goes back to sleep.

This is what we mean by self-healing. Not "the AI fixes it without you." But "the system makes the fix you'd have made anyway, and shows you the work, in three minutes instead of an hour." The human is still in the loop — they read, they decide, they apply. Janusly removes the toil between the alert and the green replay.

## Brand voice notes

For anyone writing new Janusly copy — landing pages, decks, social posts, sales emails — these are the rules that keep us in voice:

- **Concrete over abstract.** A scene ("3am, billing flow, credential rotated") lands harder than a claim ("we enable resilient AI workflows"). When in doubt, write the scene.
- **Honest about today vs. destination.** Janusly is **being built**. We say what ships today (Recovery Center, patch suggestions, sandbox validation, version rollback) and what is the direction (the operational backbone for every AI workflow that matters). Conflating the two erodes trust.
- **Engineering reality as proof.** Every brand claim should be cashable in a route path, a table name, a feature already shipped. If a marketing line can't be backed by something a developer could point at, it is fluff. Cut it.
- **Never "AI fixes everything."** The human is in the loop. The AI proposes; the operator decides. Any line that suggests Janusly is a magic auto-fix is wrong about both the product and the position. Catch this and rewrite.
- **MTTR is the metric of record.** When we name a number, it's Mean Time To Recovery for failed automations. Other metrics are interesting; MTTR is the one we own.
- **Anti-positioning earns trust.** Saying what we are not (Zapier, n8n, RPA, agents-that-do-everything) is not a put-down — it is respect for the buyer who has seen all four. Keep it crisp, never snarky.

When you draft new copy, run it past this list. If any line breaks one of these rules, rewrite it before publishing.
