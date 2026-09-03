# Demo: Multi-agent decision support

**Template:** `multi-agent-decision` in `internal/httpapi/assets/templates.json`
**Audience:** AI builders, agencies, technical AI buyers
**Time:** 3-5 minutes
**Story:** "Single-shot prompts produce single-shot opinions. Multi-agent debate produces opinions you can actually defend. Watch three agents — optimist, skeptic, arbiter — disagree productively about a real decision."

## Setup

| Need | How |
| --- | --- |
| No credentials | The template ships with `requiredCredentials: []`. |
| AI provider key (optional) | `ANTHROPIC_API_KEY` for real LLM debate. Without one, every agent's response falls back to the deterministic stub — the workflow still completes, just with placeholder content. The fallback contract is itself a demo beat. |
| Sample proposal | `{ "proposal": "Replace our self-hosted Postgres with a managed RDS instance for the analytics database." }` |
| Email provider (optional) | Default `noop` mailer; audit row lands without delivery. |

## Run sequence

1. AI Studio → Templates → click **Multi-agent decision support (debate + arbiter)**. The 3-node DAG renders: `trigger` (webhook) → `debate` (multi_agent, 3 agents) → `send_decision` (email.send tool).
2. **Save** → **Run** with the sample proposal payload.
3. Timeline walks through:
   - `webhook.received`
   - `multi_agent.started` with `count: 3, mode: "sequential"`.
   - `multi_agent.agent.started` for the **optimist** → `multi_agent.agent.completed` (the agent's arguments FOR the proposal are visible).
   - `multi_agent.agent.started` for the **skeptic**, with the optimist's output threaded into the shared context → `multi_agent.agent.completed` (counter-arguments).
   - `multi_agent.agent.started` for the **arbiter**, with both prior outputs visible → `multi_agent.agent.completed` (the final 3-sentence recommendation).
   - `multi_agent.completed` with the `finalAnswer` field populated.
   - `tool.completed` (email.send) — the decision is mailed.

## Observability story

- **Run timeline** captures every agent's input, output, and latency. The arbiter's final answer is the headline; the optimist and skeptic's intermediate reasoning is the audit trail behind it.
- **Audit log** records `workflow.saved`, `workflow.started`, `tool.executed`. The multi-agent debate itself does NOT write per-agent audit rows; the run events provide the per-agent trail.
- **Usage events** records `llm.completion` THREE TIMES — one per agent — with separate token counts and costs. The budget dashboard shows the total cost of the debate alongside other workflows for fairness.
- **Per-agent latency** lets the operator tune `maxSteps` per agent to control cost / quality tradeoffs.

## Human-in-the-loop story

The default debate runs unattended — the arbiter agent IS the final decision. For a "human ratifies the arbiter" upgrade, wire an `approval` node between `debate` and `send_decision`: the human sees the full debate transcript in the approval prompt and either ratifies the arbiter's recommendation or overrides. The pattern is identical to the Refund triage demo.

For a more sophisticated upgrade, swap the arbiter agent for a `human_form` node — the human is asked to pick the winning side (optimist / skeptic / hybrid) and write a 1-sentence rationale. The form's structured output replaces the arbiter's free-form answer.

## Recovery story

Three failure modes worth surfacing:

- **AI provider quota exhausted** — each agent's LLM call returns `{ mode: "fallback", aiError }`. The agents still complete (with stub responses); the arbiter still writes a recommendation (also stub); the email still sends. The DLQ does NOT fire — the AI fallback contract guarantees the workflow reaches `succeeded` even without a real LLM.
- **Agent timeout** — set `timeoutMs: 5000` on an agent; if the LLM takes longer, the agent is interrupted. The `multi_agent` node continues with the remaining agents (`continueOnError: true` keeps the chain going). The Recovery Queue does NOT see this — it's expected behavior.
- **Mode swap** — flipping `mode: "sequential"` to `mode: "parallel"` runs all three agents simultaneously; they don't see each other's outputs. Useful when the agents are independent reviewers rather than a debate; the arbiter's quality drops because it can't read the other agents' work.

## Closing metric

**Decision quality / defensibility, before vs after.** Hard to measure precisely, but anecdotal feedback from agencies running this pattern: the arbiter's recommendation is consistently more nuanced than a single-shot prompt, and the optimist/skeptic transcripts are the audit trail leadership asks for. "Why did the AI recommend this?" has a real answer.

## 3-5 minute talk track

> **(0:00–0:30, the pitch)**
> Anyone can call an LLM with a prompt. The interesting work is structuring how multiple LLM calls TALK TO EACH OTHER. Janusly's multi-agent primitive is built for exactly this.
>
> **(0:30–1:30, the happy path)**
> Three agents. The optimist argues FOR a proposal — should we move to managed Postgres? The skeptic sees the optimist's arguments and counters. The arbiter sees both sides and writes a defensible final recommendation. All three are LLM calls, all three are sequenced through shared context, all three are observable.
>
> **(1:30–2:30, the timeline)**
> Watch the multi-agent timeline. The optimist's arguments. The skeptic's counters. The arbiter's synthesis. Each agent's LLM call is metered separately — the usage dashboard shows three line items per debate. The cost is real and bounded.
>
> **(2:30–3:30, the breadth story)**
> This is what Janusly does that Zapier and n8n cannot. A debate is not a workflow — it's an orchestration primitive. We give you the primitive AND the observability AND the cost controls. You give us the agents' personas.
>
> **(3:30–4:30, the close)**
> Multi-agent debate, fully observable, fully cost-governed, ready to ratify with a human gate. The number we track is decision quality — and the transcript is the proof.
