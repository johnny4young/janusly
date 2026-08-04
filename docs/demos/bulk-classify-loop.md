# Demo: Bulk customer classify with loop

**Template:** `bulk-classify-loop` in `internal/httpapi/assets/templates.json`
**Audience:** Scale / data-volume buyers, customer-success and growth teams
**Time:** 3-5 minutes
**Story:** "Send a batch of customers in, get back a ranked list with one-line reasoning per row. The loop primitive normalizes the batch; the AI classifies in one grouped call; the digest mails to the customer-success team. Predictable cost, predictable latency, even at scale."

## Setup

| Need | How |
| --- | --- |
| No credentials | The template ships with `requiredCredentials: []`. |
| AI provider key (optional) | `ANTHROPIC_API_KEY` for real classification. Without one, fallback contract gives a stub digest. |
| Email provider (optional) | Default `noop` mailer. |
| Sample payload | `{ "customers": [{ "id": "c1", "email": "leah@example.com", "plan": "free" }, { "id": "c2", "email": "max@example.com", "plan": "team" }, { "id": "c3", "email": "sam@example.com", "plan": "free" }] }` |

## Run sequence

1. AI Studio → Templates → click **Bulk customer classify → digest email**. The 4-node DAG renders: `trigger` (webhook) → `normalize` (loop) → `classify` (ai) → `send_digest` (email.send tool).
2. **Save** → **Run** with the sample payload.
3. Timeline walks through:
   - `webhook.received` — payload with the array.
   - `loop.completed` with `count: 3, items: [...]` — each item is the rendered template line `"Customer c1 — plan=free, email=leah@example.com"` etc.
   - `ai.completed` — one LLM call with the full normalized list in the prompt; output is the ranked digest.
   - `tool.completed` (email.send) — the digest is mailed.

## Observability story

- **Run timeline** captures the loop's count + per-iteration output AND the AI's single grouped call. The AI cost scales with the loop size (more items = bigger prompt), not with the loop COUNT (no per-item LLM call).
- **Audit log** records `workflow.saved`, `workflow.started`, `tool.executed` (the email).
- **Usage events** records ONE `llm.completion` row with the total token count for the grouped prompt — operators see a predictable cost per batch.
- **Why loop + grouped AI vs per-item LLM** — calling the LLM once per customer scales linearly in cost and latency; grouping them into one call is ~10x cheaper and ~10x faster for typical batch sizes (10-100 customers). The loop primitive is the right scale primitive for this shape.

## Human-in-the-loop story

For a "human reviews the digest before mailing" upgrade, wire an `approval` node between `classify` and `send_digest`. The customer-success lead reads the AI's ranking in the approval prompt and decides whether to ship the digest. Common when the digest goes to executives.

For a more sophisticated upgrade, swap the loop's `mapping` from a string template to one that materializes per-customer human review items in a `human_form` schema. The form lets the operator flag specific customers for individual outreach BEFORE the batch classification happens.

## Recovery story

Three failure modes worth surfacing:

- **Empty `customers` array** — the loop returns `{ count: 0, items: [] }`. The AI prompt gets `Customers (0 total):` and produces a fallback "no customers to classify" digest. The email still sends. Operators wire a `condition` node after `normalize` if they want to halt when the batch is empty.
- **Mapped item shape drift** — if a customer object is missing `id` or `plan` or `email`, the loop's template substitution leaves the placeholder intact (e.g., `Customer c1 — plan={{item.plan}}, email=...`). The AI prompt receives the broken placeholder verbatim; the classification quality drops. Recovery is upstream: validate the input schema at the webhook trigger.
- **Batch too large** — if `customers` has 10_000 items, the loop completes fine but the AI prompt becomes hundreds of KB. The LLM call either errors (provider rejection) or runs slow. Recovery: insert a sub-batching step (slice the array, run the loop+ai pair on each slice, aggregate results) or upgrade to a sub-workflow per batch.

## Closing metric

**Customers classified per dollar.** Single-shot per-customer LLM calls run ~$0.001-0.01 per customer depending on model. Grouped per-batch calls run ~$0.05-0.10 per BATCH (typically 50-100 customers). Operators ship the same outcome at ~10-50x lower cost. Multiply by daily/weekly batch frequency.

## 3-5 minute talk track

> **(0:00–0:30, the pitch)**
> Customer-success teams classify customer lists every week — who's a churn risk, who's an upgrade candidate, who needs a check-in. The naive approach is one LLM call per customer. That gets expensive fast. The Janusly approach is one LLM call per batch.
>
> **(0:30–1:30, the happy path)**
> Webhook receives 100 customers. The loop primitive normalizes each one into a summary line — plan, email, id. The AI step sees all 100 lines in one prompt and returns a ranked digest with reasoning per row. The email step delivers the digest to the customer-success channel.
>
> **(1:30–2:30, the cost story)**
> Look at the usage dashboard — ONE LLM call, not 100. The token count scales with the batch size in the prompt, but the per-customer cost drops 10-50x. Predictable, bounded, billable.
>
> **(2:30–3:30, the scale story)**
> What happens at 10,000 customers? The loop still completes — it's a template substitution, basically free. The AI prompt gets big. We either chunk it via a sub-workflow per batch, or we route to a larger-context model. Both options are config changes, not workflow rewrites.
>
> **(3:30–4:30, the close)**
> Bulk classification with predictable cost, full observability, and a one-config-change path to higher scale. The number we track is customers classified per dollar — and this demo just optimized that 10x.
