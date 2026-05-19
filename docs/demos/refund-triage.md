# Demo: Refund triage

**Template:** [`refund-triage-approval`](../../apps/api/src/templates.ts)
**Audience:** Revenue ops, finance ops, customer-support team leads
**Time:** 3-5 minutes
**Story:** "When a refund request comes in, the human signs off, the billing system gets a signed call, and the customer is told what happened. Janusly does the routing; the human keeps the judgment call."

## Setup

| Need | How |
| --- | --- |
| `webhook_secret` credential | AI Studio → Credentials → New, kind `webhook_secret`, name `partner-webhook`. The shared secret lives in env (`PARTNER_WEBHOOK_SECRET`); the credential row stores only the env-var name. |
| Email provider key (Resend or SendGrid) | Set `RESEND_API_KEY` or `SENDGRID_API_KEY` in env. Without one, the email step falls back to the `noop` mailer — the audit row still lands, no email is delivered. The demo works either way. |
| Sample refund payload | `{ "customer": "leah@example.com", "orderId": "ord_8421", "amountUsd": 49.00, "reason": "Charged twice for the same order" }` |
| (Optional) endpoint to receive the signed webhook | If you want to show the billing-system side, point a test ngrok / RequestBin / local server at `billing.example.com/refunds` (edit the `process_refund` node's URL in the Inspector). |

## Run sequence

1. AI Studio → Templates → click **Refund triage → approval → billing webhook**. The 5-node DAG renders: `trigger` → `analyze` (ai) → `human_review` (approval) → `process_refund` (webhook.send tool) → `confirm_email` (email.send tool).
2. **Save** → **Run** with the sample payload.
3. Watch the timeline: `webhook.received` → `ai.completed` (the AI's 2-sentence claim summary appears) → run goes `waiting` on `human_review`.
4. Switch to the Runs tab. The pending run shows a yellow "Awaiting approval" badge with the approval prompt visible (it interpolates the customer name, amount, and AI analysis).
5. Click **Approve**. The run resumes immediately.
6. `process_refund` fires — the timeline shows the signed POST going out, including the `X-Janusly-Signature: t=<unix>,v1=<hmac-hex>` header that the receiving system uses to verify.
7. `confirm_email` fires — the customer receives the refund confirmation (or audit row lands, if mailer is noop).

## Observability story

- **Run timeline** shows the approval decision inline with the operator's user id — auditors can trace who approved each refund.
- **Audit log** records `workflow.saved`, `workflow.started`, `run.resumed` (with the resuming user), `tool.executed` (twice). The approve/reject decision is non-repudiable.
- **Signed HMAC outbound** — the `webhook.send` tool computes `HMAC-SHA256(<timestamp>.<body>, <shared-secret>)` over the exact serialized JSON body. The receiving system verifies in ~5 lines of code. No vendor SDK on either side.
- **Usage events** captures AI tokens, the outbound webhook latency, and the email delivery.

## Human-in-the-loop story

The `approval` node is the headline. The prompt the human sees is templated from the workflow context, so the operator reads "Approve refund of $49.00 for leah@example.com (order ord_8421)? AI analysis: …" — they have everything they need to decide in one screen. The decision is captured in the run timeline AND the audit log; downstream nodes do not fire until the human resumes.

For trickier cases (refund amount above a threshold, customer flagged as VIP), upgrade to `human_form` instead of `approval` — the human can override the AI's claim summary, add a notes field, and pick a refund category from a closed enum. The mechanics are identical; the form is just structured input.

## Recovery story

The recovery angle: "what happens when the billing system 401s us?" In live demo mode, point the `process_refund` URL at a host that returns 401. The webhook node returns `{ ok: false, statusCode: 401, error }`. Two recovery paths:

- **DLQ + Recovery Queue** — the operator opens the failed run, sees the 401, opens the Recovery dialog. The AI's top suggestion is `swap_secret_ref`: bind the credential to the right env-var name. One click → sandbox validation → replay.
- **Halt-on-failure design** — for refund flows where you want to STOP rather than continue to `confirm_email`, wire a `condition` node after `process_refund` that gates on `{{context.process_refund.output.result.ok}}`. The condition routes failures to a "manual review" branch.

## Closing metric

**Approvals processed per operator hour, before vs after.** Manual refund triage (read the ticket, lookup the order, check the customer history, decide, file the refund in the billing system, email the customer) is 8-15 minutes per case. Janusly's flow is the same human decision plus 30 seconds for the rest. Multiply by a refund team's daily volume.

## 3-5 minute talk track

> **(0:00–0:30, problem framing)**
> Refunds are the perfect Janusly use case: a human SHOULD make the call, but everything around the call is paperwork that wastes their time.
>
> **(0:30–1:30, the happy path)**
> Here's a refund triage flow. Customer ticket arrives via webhook. AI summarizes the claim — including red flags. The human sees the summary and the dollar amount and approves with one click. The signed billing webhook fires — note the HMAC signature — and the customer gets an email confirmation.
>
> **(1:30–2:30, why HITL is the headline)**
> The human spends 30 seconds, not 15 minutes. The AI handles the routing and the formatting; the human keeps the judgment call. The audit log records who approved each refund — that's what your finance team will ask for at year-end close.
>
> **(2:30–3:30, the recovery angle)**
> Watch what happens when our billing system credentials are wrong. The webhook returns 401. The Recovery Queue surfaces the failure; the AI suggests `swap_secret_ref` and offers to wire the right credential. Sandbox validation confirms; we replay; we're back to processing refunds.
>
> **(3:30–4:30, the close)**
> One human decision, everything else automated, signed outbound, fully audited, and self-healing when the billing system has a bad day. The number we track for you is approvals per operator hour — and this demo just multiplied that.
