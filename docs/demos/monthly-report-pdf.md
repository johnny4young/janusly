# Demo: Monthly metrics report with PDF + email

**Template:** `monthly-report-pdf` in `internal/httpapi/assets/templates.json`
**Audience:** Enterprise ops, finance ops, business analytics buyers
**Time:** 3-5 minutes
**Story:** "Every month, the operations team manually pulls metrics, summarizes them, exports a PDF, and emails it to leadership. Janusly does the whole loop on cron, with the AI doing the narrative summary."

## Setup

| Need | How |
| --- | --- |
| No credentials | The template ships with `requiredCredentials: []`. Mailer + object store come from env. |
| Object store (optional, for real PDFs) | Set `JANUSLY_OBJECT_STORE_PROVIDER=local` with `JANUSLY_OBJECT_STORE_LOCAL_DIR=./pdfs` for local-dir storage. Or `s3` with `JANUSLY_OBJECT_STORE_BUCKET` for S3 / R2 / B2. Default `noop` returns `{ ok: true, url: undefined }` — the demo works but no real file is produced. |
| Email provider (optional) | `RESEND_API_KEY` or `SENDGRID_API_KEY`. Default `noop` mailer returns success without delivering. |
| Analytics endpoint | The checked-in URL is the placeholder `https://analytics.example.com/monthly-metrics`. Point `fetch_metrics.config.url` at a reachable JSON endpoint for the live happy path; otherwise the http node may fail before AI/PDF/email run. |
| Manual trigger | The template's `schedule` node is set to `0 9 1 * *` (1st of each month at 9am). For the demo, manually trigger via the **Run** button — the schedule node is a passthrough when fired manually. |

## Run sequence

1. AI Studio → Templates → click **Monthly metrics report → PDF → email**. The 5-node DAG renders: `trigger` (schedule, cron `0 9 1 * *`) → `fetch_metrics` (http) → `summarize` (ai) → `render_pdf` (pdf.generate tool) → `send_report` (email.send tool).
2. **Save** → **Run**.
3. Timeline walks through:
   - `schedule.fired` — the cron node passes through when manually triggered.
   - `http.completed` — the analytics endpoint returns a metrics payload after you point the placeholder URL at your own endpoint for live data.
   - `ai.completed` — the AI produces a 3-paragraph executive summary.
   - `tool.completed` (pdf.generate) — the PDF is rendered and uploaded; the node output carries `{ ok: true, provider, url, key, contentLength }`.
   - `tool.completed` (email.send) — the email goes out with the PDF link in the body.
4. Open the PDF from the URL in the timeline — confirm the rendered Markdown looks polished.

## Observability story

- **Run timeline** shows each node's latency and output. The PDF size (`contentLength`) and the email's `providerMessageId` are captured.
- **Audit log** captures `workflow.saved`, `workflow.started`, `tool.executed` (twice — pdf + email).
- **Usage events** captures `llm.completion`, `pdf.generated` (with provider + byte count for billing), and `email.sent` (with provider + delivery status).
- **Budget dashboard** rolls up the AI cost AND the PDF byte cost AND the email count — operators see the monthly run's cost trail in one place.
- **Schedule registry** — the schedule is registered in PostgreSQL by the Janusly runtime; the next firing time is visible in the Workflows panel.

## Human-in-the-loop story

The default flow is unattended — that is the point of a scheduled monthly report. For an "approval-before-send" upgrade, wire an `approval` node between `summarize` and `send_report`: the operations lead reviews the AI's summary in the human gate, edits if needed (via `human_form` for editable summaries), and approves before the report mails to leadership. The Refund triage demo shows this pattern in detail.

## Recovery story

Three failure modes worth surfacing:

- **HTTP analytics endpoint down** — the `http` node throws on failed fetch / non-2xx and the run lands in DLQ on `fetch_metrics`; downstream AI/PDF/email steps do not run until the operator patches the URL or adds an explicit branch around the fetch.
- **PDF rendering fails** — exceeds the 200KB template cap, exceeds the 32-deep nesting cap, or hits the CPU-bound block cap. The tool returns `{ ok: false, error }`; the current linear template still runs the email step, so add a `condition` after `render_pdf` if the demo needs a separate PDF-failure branch.
- **Email provider quota exceeded** — the mailer returns `{ ok: false, error: "Quota exceeded" }`. The Recovery Queue surfaces the failure; the AI suggests `swap_credential` (try a different mailer) or `add_retry` (transient).

## Closing metric

**Hours per month saved on operations reporting.** A typical manual loop (pull metrics, write summary, format Doc, export PDF, email leadership) is 2-4 hours per month per business unit. Janusly's loop is zero operator hours after setup — the AI summary quality is the only thing the human reviews, on the months they choose to review at all.

## 3-5 minute talk track

> **(0:00–0:30, the pitch)**
> Every operations team has a monthly metrics ritual: pull the numbers, write the summary, format the PDF, email it to leadership. Two to four hours of someone's time, every month, predictably. Watch Janusly do the whole loop.
>
> **(0:30–1:30, the happy path)**
> Five-node workflow. Cron fires on the first of the month at 9am. HTTP pulls the metrics from our analytics endpoint. AI writes the three-paragraph executive summary. PDF gets rendered — note the Markdown template — and uploaded to our object store. Email goes out with the PDF link. End to end, under 30 seconds.
>
> **(1:30–2:30, the observability)**
> Here's the timeline. Each step's latency, the PDF byte count, the email's provider message id. The audit log captures the run; the usage dashboard captures the cost; the budget tile keeps the monthly run within bounds.
>
> **(2:30–3:30, the breadth story)**
> What this demo proves: Janusly isn't just an integration platform. It's an OPERATING platform. Cron, HTTP, AI, PDF, email — all primitives, all observable, all cost-governed, all in one workflow. Zapier won't render the PDF for you. n8n won't tell you the cost.
>
> **(3:30–4:30, the close)**
> Set this once. Forget about it for a year. The monthly report lands in leadership's inbox while your operations team does work that actually moves the business. The number we track for you is operator hours saved per month — and this demo just gave back four of them.
