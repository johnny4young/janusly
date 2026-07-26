/**
 * Built-in recipe catalog — each entry pairs a description with a fully-
 * formed `Workflow` DAG. The AI Studio's Templates panel reads this via
 * `GET /templates`; selected eval fixtures also pin these ids as deterministic
 * fallback templates when no LLM key is configured.
 *
 * Used by `apps/api/src/routes/templates-routes.ts` `GET /templates` and indirectly by the
 * `/ai/generate-workflow` fallback path (matches an `id` from this catalog
 * when the LLM is unavailable).
 *
 * Invariants:
 * - Adding a new template means adding a deterministic `fallbackTemplate`
 *   id to `evals/generate-workflow.jsonl` if the eval should anchor on it.
 * - `id` values are part of the public API surface — renaming a template
 *   breaks bookmarks + eval cases.
 * - `requiredCredentials` lists the `credentials.kind` values an operator
 *   must have inserted before running the template (e.g. `slack_webhook`,
 *   `github_token`). It is informational only — runtime still enforces
 *   credential presence per-tool via `getCredentialByName` — but the UI
 *   uses it to render "needs: …" badges on the Templates panel so the
 *   operator can spot gaps before clicking "Run".
 * - Templates are copy-on-use: clicking a template clones its DAG into a
 *   fresh saved workflow in the operator's org. The template itself is
 *   immutable code and never linked back to the saved workflow.
 */

import type { Workflow } from "@janusly/shared";

/** One recipe entry: id + display fields + the full DAG. */
export type WorkflowTemplate = {
  id: string;
  name: string;
  description: string;
  category: string;
  /**
   * Closed list of credential `kind` values the operator must have
   * configured before running this template. Empty/omitted when the
   * template has no credential prerequisites (e.g. `http-ai-summary`).
   * Surfaced to the UI through `GET /templates`; not a server-side gate.
   */
  requiredCredentials?: string[];
  workflow: Workflow;
};

/**
 * Public-facing template entry returned by `GET /templates`. Identical to
 * `WorkflowTemplate` plus stable codes so the web layer can translate the
 * `name` / `description` / `category` fields via the i18n catalog
 * (`apps/web/src/i18n/locales/<lng>/common.json` keys
 * `templates.<id>.{name,description}` + `templates.category.<category>`).
 *
 * Codes are derived deterministically from `id` / `category` so the
 * mapping stays trivial: a brand-new template ships English-only by
 * virtue of the catalog miss falling back to the literal `name` /
 * `description` field; mirror the keys later to localise.
 */
export type WorkflowTemplatePublic = WorkflowTemplate & {
  nameCode: string;
  descriptionCode: string;
  categoryCode: string;
};

/** Stable code derived from a template id. `http-ai-summary` → `http-ai-summary.name`. */
function templateNameCode(id: string): string { return `${id}.name`; }
function templateDescriptionCode(id: string): string { return `${id}.description`; }
/** Slug a category label into a stable code: `Human-in-the-loop` → `human-in-the-loop`. */
function templateCategoryCode(category: string): string {
  return category.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Decorate a `WorkflowTemplate` with translation codes. Pure; no I/O. */
export function asPublicTemplate(template: WorkflowTemplate): WorkflowTemplatePublic {
  return {
    ...template,
    nameCode: templateNameCode(template.id),
    descriptionCode: templateDescriptionCode(template.id),
    categoryCode: templateCategoryCode(template.category),
  };
}

/** All built-in recipes. New templates append to this array. */
export const workflowTemplates: WorkflowTemplate[] = [
  {
    id: "http-ai-summary",
    name: "HTTP → AI Summary",
    description: "Call an API and summarize the response with an AI/agent step.",
    category: "AI",
    requiredCredentials: [],
    workflow: {
      dslVersion: "1.0",
      id: "http-ai-summary",
      name: "HTTP → AI Summary",
      nodes: [
        { id: "api", type: "http", config: { url: "https://api.github.com" } },
        { id: "summary", type: "ai", config: { prompt: "Summarize the API response for an operator and suggest the next action: {{context.api.output.body}}" } }
      ],
      edges: [{ from: "api", to: "summary" }]
    }
  },
  {
    id: "api-transform-tool",
    name: "API → Transform → Tool",
    description: "Fetch data, map outputs, and run a backend tool.",
    category: "Data",
    requiredCredentials: [],
    workflow: {
      dslVersion: "1.0",
      id: "api-transform-tool",
      name: "API → Transform → Tool",
      nodes: [
        { id: "api", type: "http", config: { url: "https://api.github.com" } },
        { id: "transform", type: "transform", config: { mapping: { statusCode: "{{context.api.output.statusCode}}", ok: "{{context.api.output.ok}}" } } },
        { id: "tool", type: "tool", config: { tool: "text.uppercase", input: { value: "status {{context.transform.output.statusCode}}" } } }
      ],
      edges: [{ from: "api", to: "transform" }, { from: "transform", to: "tool" }]
    }
  },
  {
    id: "approval-gate",
    name: "Human Approval Gate",
    description: "Pause execution until a human approves the run.",
    category: "Human-in-the-loop",
    requiredCredentials: [],
    workflow: {
      dslVersion: "1.0",
      id: "approval-gate",
      name: "Human Approval Gate",
      nodes: [
        { id: "start", type: "noop", config: {} },
        { id: "approval", type: "approval", config: { message: "Approve to continue." } },
        { id: "done", type: "noop", config: {} }
      ],
      edges: [{ from: "start", to: "approval" }, { from: "approval", to: "done" }]
    }
  },
  {
    id: "incident-triage",
    name: "Incident triage → GitHub + Slack",
    description: "Webhook receives an incident, AI summarizes it, GitHub gets a tracking issue, Slack notifies the on-call channel.",
    category: "Operations",
    requiredCredentials: ["github_token", "slack_webhook"],
    workflow: {
      dslVersion: "1.0",
      id: "incident-triage",
      name: "Incident triage → GitHub + Slack",
      nodes: [
        { id: "trigger", type: "webhook", config: {} },
        {
          id: "summarize",
          type: "ai",
          config: {
            prompt: "You are an SRE assistant. Given this incident payload, write a 2-3 sentence summary suitable for a GitHub issue body. Payload: {{context.trigger.output}}"
          }
        },
        {
          id: "github_issue",
          type: "tool",
          config: {
            tool: "github.create_issue",
            input: {
              credential: "bot-github",
              owner: "janusly",
              repo: "incidents",
              title: "Incident: {{context.trigger.output.alertName}}",
              body: "{{context.summarize.output.response}}",
              labels: ["incident", "auto-triaged"]
            }
          }
        },
        {
          id: "slack_notify",
          type: "tool",
          config: {
            tool: "slack.post",
            input: {
              credential: "incidents-slack",
              text: "New incident: {{context.trigger.output.alertName}} — tracked at {{context.github_issue.output.result.url}}"
            }
          }
        }
      ],
      edges: [
        { from: "trigger", to: "summarize" },
        { from: "summarize", to: "github_issue" },
        { from: "github_issue", to: "slack_notify" }
      ]
    }
  },
  {
    id: "customer-escalation-router",
    name: "Customer escalation → Severity-routed response",
    description: "Webhook receives a complaint, AI classifies severity, and condition-guarded edges fan out to one of three escalation branches: low (Slack ping), medium (GitHub issue + Slack), or high (human review + GitHub issue + urgent Slack alert).",
    category: "Operations",
    requiredCredentials: ["slack_webhook", "github_token"],
    workflow: {
      dslVersion: "1.0",
      id: "customer-escalation-router",
      name: "Customer escalation → Severity-routed response",
      inputs: {
        type: "object",
        required: ["customer", "complaint"],
        properties: {
          customer: { type: "string", description: "Customer name or account id" },
          complaint: { type: "string", description: "The complaint text submitted by the customer" }
        }
      },
      nodes: [
        { id: "trigger", type: "webhook", config: {} },
        {
          id: "classify",
          type: "ai",
          config: {
            prompt: "You are a customer-support triage assistant. Classify the severity of the following complaint as EXACTLY one lowercase word, no punctuation, no whitespace: `low` | `medium` | `high`. Use impact, urgency, and tone. Complaint: {{context.trigger.output.complaint}}"
          }
        },
        {
          id: "low_notify",
          type: "tool",
          config: {
            tool: "slack.post",
            input: {
              credential: "incidents-slack",
              text: "Customer feedback (low): {{context.trigger.output.customer}} — {{context.trigger.output.complaint}}"
            }
          }
        },
        {
          id: "med_track",
          type: "tool",
          config: {
            tool: "github.create_issue",
            input: {
              credential: "bot-github",
              owner: "your-org",
              repo: "support-tickets",
              title: "[medium] {{context.trigger.output.customer}}: customer complaint",
              body: "Severity: medium\n\nComplaint: {{context.trigger.output.complaint}}\n\nClassification: {{context.classify.output.response}}",
              labels: ["customer-escalation", "medium"]
            }
          }
        },
        {
          id: "med_notify",
          type: "tool",
          config: {
            tool: "slack.post",
            input: {
              credential: "incidents-slack",
              text: ":warning: Medium escalation logged for {{context.trigger.output.customer}}: {{context.med_track.output.result.url}}"
            }
          }
        },
        {
          id: "high_review",
          type: "human_form",
          config: {
            title: "High-severity customer escalation",
            description: "Review and confirm the response approach before the ticket is filed.",
            schema: {
              type: "object",
              required: ["responseSummary", "owner"],
              properties: {
                responseSummary: { type: "string", description: "Short summary of how this will be addressed" },
                owner: { type: "string", description: "Slack handle or email of the responsible person" }
              }
            }
          }
        },
        {
          id: "high_track",
          type: "tool",
          config: {
            tool: "github.create_issue",
            input: {
              credential: "bot-github",
              owner: "your-org",
              repo: "support-tickets",
              title: "[HIGH] {{context.trigger.output.customer}}: customer escalation",
              body: "Severity: high\n\nComplaint: {{context.trigger.output.complaint}}\n\nResponse plan: {{context.high_review.output.responseSummary}}\nOwner: {{context.high_review.output.owner}}",
              labels: ["customer-escalation", "high", "needs-followup"]
            }
          }
        },
        {
          id: "high_notify",
          type: "tool",
          config: {
            tool: "slack.post",
            input: {
              credential: "incidents-slack",
              text: ":rotating_light: HIGH escalation from {{context.trigger.output.customer}} — owner: {{context.high_review.output.owner}} — {{context.high_track.output.result.url}}"
            }
          }
        }
      ],
      edges: [
        { from: "trigger", to: "classify" },
        { from: "classify", to: "low_notify",  condition: "context.classify.output.response === \"low\"" },
        { from: "classify", to: "med_track",   condition: "context.classify.output.response === \"medium\"" },
        { from: "classify", to: "high_review", condition: "context.classify.output.response === \"high\"" },
        { from: "med_track", to: "med_notify" },
        { from: "high_review", to: "high_track" },
        { from: "high_track", to: "high_notify" }
      ]
    }
  },
  {
    id: "lead-enrichment-handoff",
    name: "Lead enrichment → sales handoff",
    description: "Webhook receives a marketing-form lead, AI scores and enriches it, and a condition routes qualified leads to Slack + a welcome email while unqualified leads receive a nurture-sequence email.",
    category: "Revenue",
    requiredCredentials: ["slack_webhook"],
    workflow: {
      dslVersion: "1.0",
      id: "lead-enrichment-handoff",
      name: "Lead enrichment → sales handoff",
      inputs: {
        type: "object",
        required: ["email", "company", "role"],
        properties: {
          email: { type: "string", description: "Lead email address" },
          company: { type: "string", description: "Company name" },
          role: { type: "string", description: "Job title the lead reported" },
          teamSize: { type: "number", description: "Self-reported team size; optional but boosts the qualification score" }
        }
      },
      nodes: [
        { id: "trigger", type: "webhook", config: {} },
        {
          id: "score",
          type: "ai",
          config: {
            prompt: "You are a sales qualification assistant. Score the following lead based on title seniority, company name, and team size. Respond with EXACTLY one lowercase word, no punctuation, no whitespace: `qualified` or `unqualified`. Lead: email={{context.trigger.output.email}}, company={{context.trigger.output.company}}, role={{context.trigger.output.role}}, teamSize={{context.trigger.output.teamSize}}"
          }
        },
        {
          id: "decide",
          type: "condition",
          config: { expression: "context.score.output.response === \"qualified\"" }
        },
        {
          id: "sales_notify",
          type: "tool",
          config: {
            tool: "slack.post",
            input: {
              credential: "incidents-slack",
              text: ":dart: New qualified lead — {{context.trigger.output.email}} from {{context.trigger.output.company}} ({{context.trigger.output.role}}). AI rationale: {{context.score.output.response}}"
            }
          }
        },
        {
          id: "welcome_email",
          type: "tool",
          config: {
            tool: "email.send",
            input: {
              to: "{{context.trigger.output.email}}",
              subject: "Welcome to Janusly — let's set up a quick call",
              text: "Hi {{context.trigger.output.company}} team,\n\nThanks for reaching out. We'd love to learn more about how you'd use Janusly. Reply to this thread and we'll get on a 15-minute call this week."
            }
          }
        },
        {
          id: "nurture_email",
          type: "tool",
          config: {
            tool: "email.send",
            input: {
              to: "{{context.trigger.output.email}}",
              subject: "Janusly for {{context.trigger.output.company}} — when you're ready",
              text: "Hi {{context.trigger.output.company}} team,\n\nThanks for your interest in Janusly. We've added you to our monthly product update; reply any time when the timing's right for a deeper look."
            }
          }
        }
      ],
      edges: [
        { from: "trigger", to: "score" },
        { from: "score", to: "decide" },
        { from: "decide", to: "sales_notify", condition: "context.decide.output.result" },
        { from: "decide", to: "welcome_email", condition: "context.decide.output.result" },
        { from: "decide", to: "nurture_email", condition: "!context.decide.output.result" }
      ]
    }
  },
  {
    id: "refund-triage-approval",
    name: "Refund triage → approval → billing webhook",
    description: "Webhook receives a refund request, AI summarizes the claim, a human approval gate decides yes/no, then a signed webhook calls the billing system and an email confirms to the customer.",
    category: "Revenue",
    requiredCredentials: ["webhook_secret"],
    workflow: {
      dslVersion: "1.0",
      id: "refund-triage-approval",
      name: "Refund triage → approval → billing webhook",
      inputs: {
        type: "object",
        required: ["customer", "orderId", "amountUsd", "reason"],
        properties: {
          customer: { type: "string", description: "Customer email or account id" },
          orderId: { type: "string", description: "Original order id the refund applies to" },
          amountUsd: { type: "number", description: "Refund amount in USD" },
          reason: { type: "string", description: "Free-text reason the customer provided" }
        }
      },
      nodes: [
        { id: "trigger", type: "webhook", config: {} },
        {
          id: "analyze",
          type: "ai",
          config: {
            prompt: "You are a refund-triage assistant. Summarize the refund claim in 2 short sentences highlighting whether the reason sounds legitimate, any red flags, and the dollar impact. Claim: customer={{context.trigger.output.customer}}, order={{context.trigger.output.orderId}}, amountUsd={{context.trigger.output.amountUsd}}, reason={{context.trigger.output.reason}}"
          }
        },
        {
          id: "human_review",
          type: "approval",
          config: { message: "Approve refund of ${{context.trigger.output.amountUsd}} for {{context.trigger.output.customer}} (order {{context.trigger.output.orderId}})?\n\nAI analysis: {{context.analyze.output.response}}" }
        },
        {
          id: "process_refund",
          type: "tool",
          config: {
            tool: "webhook.send",
            input: {
              credential: "partner-webhook",
              url: "https://billing.example.com/refunds",
              payload: {
                customer: "{{context.trigger.output.customer}}",
                orderId: "{{context.trigger.output.orderId}}",
                amountUsd: "{{context.trigger.output.amountUsd}}",
                approvedBy: "janusly-approval"
              }
            }
          }
        },
        {
          id: "confirm_email",
          type: "tool",
          config: {
            tool: "email.send",
            input: {
              to: "{{context.trigger.output.customer}}",
              subject: "Your refund for order {{context.trigger.output.orderId}} has been processed",
              text: "Hi,\n\nWe processed your refund of ${{context.trigger.output.amountUsd}} for order {{context.trigger.output.orderId}}. It should hit your account within 5-10 business days.\n\nReply to this thread if anything looks off."
            }
          }
        }
      ],
      edges: [
        { from: "trigger", to: "analyze" },
        { from: "analyze", to: "human_review" },
        { from: "human_review", to: "process_refund" },
        { from: "process_refund", to: "confirm_email" }
      ]
    }
  },
  {
    id: "ai-support-draft-review",
    name: "AI support draft → human review → send",
    description: "Webhook receives a support ticket, AI drafts a response, a human agent reviews/edits via a typed form, and the final reply is emailed to the customer.",
    category: "Revenue",
    workflow: {
      dslVersion: "1.0",
      id: "ai-support-draft-review",
      name: "AI support draft → human review → send",
      inputs: {
        type: "object",
        required: ["customer", "subject", "question"],
        properties: {
          customer: { type: "string", description: "Customer email" },
          subject: { type: "string", description: "Ticket subject line" },
          question: { type: "string", description: "Customer's full question" }
        }
      },
      nodes: [
        { id: "trigger", type: "webhook", config: {} },
        {
          id: "draft",
          type: "ai",
          config: {
            prompt: "You are a customer support agent for Janusly. Write a polite, factual reply to the following ticket. Keep it under 200 words. Do NOT invent product features. Ticket subject: {{context.trigger.output.subject}}\n\nCustomer asked: {{context.trigger.output.question}}"
          }
        },
        {
          id: "review",
          type: "human_form",
          config: {
            title: "Review the AI-drafted reply before sending",
            description: "Edit the body if needed and approve to send to the customer.",
            schema: {
              type: "object",
              required: ["finalBody"],
              properties: {
                finalBody: { type: "string", description: "Final reply body. Pre-filled from the AI draft; edit as needed." },
                tone: { type: "string", description: "Optional tone tag (warm | direct | apologetic) for analytics", enum: ["warm", "direct", "apologetic"] }
              }
            }
          }
        },
        {
          id: "send",
          type: "tool",
          config: {
            tool: "email.send",
            input: {
              to: "{{context.trigger.output.customer}}",
              subject: "Re: {{context.trigger.output.subject}}",
              text: "{{context.review.output.finalBody}}"
            }
          }
        }
      ],
      edges: [
        { from: "trigger", to: "draft" },
        { from: "draft", to: "review" },
        { from: "review", to: "send" }
      ]
    }
  },
  {
    id: "churn-risk-weekly-digest",
    name: "Churn-risk weekly digest (scheduled)",
    description: "Cron-fires every Monday 9am, pulls at-risk users from a configured analytics endpoint, AI ranks them, then a digest message lands in Slack for the customer-success channel.",
    category: "Revenue",
    requiredCredentials: ["slack_webhook"],
    workflow: {
      dslVersion: "1.0",
      id: "churn-risk-weekly-digest",
      name: "Churn-risk weekly digest (scheduled)",
      nodes: [
        { id: "trigger", type: "schedule", config: { cronExpression: "0 9 * * 1", enabled: true } },
        {
          id: "fetch_signals",
          type: "http",
          config: {
            url: "https://analytics.example.com/at-risk-users",
            method: "GET"
          }
        },
        {
          id: "rank",
          type: "ai",
          config: {
            prompt: "You are a customer-success analyst. Given this at-risk-user payload, rank the top 5 customers by churn likelihood and write a one-line action for each. Keep the whole reply under 1000 chars. Payload: {{context.fetch_signals.output.body}}"
          }
        },
        {
          id: "post_digest",
          type: "tool",
          config: {
            tool: "slack.post",
            input: {
              credential: "incidents-slack",
              text: ":chart_with_upwards_trend: *Weekly churn-risk digest*\n\n{{context.rank.output.response}}"
            }
          }
        }
      ],
      edges: [
        { from: "trigger", to: "fetch_signals" },
        { from: "fetch_signals", to: "rank" },
        { from: "rank", to: "post_digest" }
      ]
    }
  },
  {
    id: "email-reply",
    name: "Email auto-reply",
    description: "Skeleton for reading inbound email and sending a templated reply via email.send. Operator fills the trigger source and recipient details in the Inspector.",
    category: "Communication",
    // The template is intentionally provider-neutral and ships as a scaffold
    // so an operator who asked the AI for an email reply gets a usefully-shaped
    // DAG when the LLM is unavailable.
    requiredCredentials: [],
    workflow: {
      dslVersion: "1.0",
      id: "email-reply",
      name: "Email auto-reply",
      nodes: [
        // Inbound fetch placeholder. The operator points this at
        // their Gmail (or other inbox) integration in the Inspector
        // before running.
        { id: "fetch_inbound", type: "noop", config: {} },
        {
          id: "match_sender",
          type: "condition",
          // Placeholder expression — the operator refines this in the
          // Inspector with the real sender-domain check once they've
          // wired the inbound source's output shape.
          config: { expression: "true" },
        },
        {
          id: "reply",
          type: "tool",
          // Placeholder values so the template loads through strict
          // `validateWorkflow` and the operator can run a smoke as
          // soon as they wire the inbound source. The Inspector
          // surface lets them override every field; the placeholders
          // are explicitly templated against the inbound match so
          // it's obvious where the real data flows from.
          config: {
            tool: "email.send",
            input: {
              to: "{{context.match_sender.output.sender}}",
              subject: "Auto-reply",
              text: "Thanks for your message — I'll get back to you shortly.",
            },
          },
        },
      ],
      edges: [
        { from: "fetch_inbound", to: "match_sender" },
        { from: "match_sender", to: "reply" },
      ],
    },
  },
  {
    id: "failed-workflow-recovery",
    name: "Failed workflow recovery → DLQ → patch → replay",
    description: "Headline recovery demo. A webhook fires a write-side billing call that is intentionally broken in two ways: no approval gate upstream of the write, and a Bearer token referencing an unbound secret. The run lands in the Recovery Queue; the AI suggests both an upstream approval insertion (structural) and a swap_secret_ref fix (config). One demo, two recovery patterns.",
    category: "Operations",
    requiredCredentials: [],
    workflow: {
      dslVersion: "1.0",
      id: "failed-workflow-recovery",
      name: "Failed workflow recovery → DLQ → patch → replay",
      inputs: {
        type: "object",
        required: ["customer", "amountUsd"],
        properties: {
          customer: { type: "string", description: "Customer email or account id" },
          amountUsd: { type: "number", description: "Amount to bill in USD" },
        },
      },
      nodes: [
        { id: "trigger", type: "webhook", config: {} },
        {
          id: "charge",
          type: "http",
          config: {
            url: "https://billing.example.com/charges",
            method: "POST",
            headers: { Authorization: "Bearer {{secret.BILLING_API_KEY}}" },
            body: {
              customer: "{{context.trigger.output.customer}}",
              amountUsd: "{{context.trigger.output.amountUsd}}",
            },
          },
        },
        {
          id: "confirm_email",
          type: "tool",
          config: {
            tool: "email.send",
            input: {
              to: "{{context.trigger.output.customer}}",
              subject: "Your charge for ${{context.trigger.output.amountUsd}}",
              text: "Hi,\n\nWe processed your charge of ${{context.trigger.output.amountUsd}}. Reply if anything looks off.",
            },
          },
        },
      ],
      edges: [
        { from: "trigger", to: "charge" },
        { from: "charge", to: "confirm_email" },
      ],
    },
  },
  {
    id: "monthly-report-pdf",
    name: "Monthly metrics report → PDF → email",
    description: "Scheduled cron fires on the first of each month, fetches metrics from an analytics endpoint, AI summarizes the top movers, pdf.generate renders a polished PDF, and email.send delivers it. Showcases schedule + http + ai + pdf + email in a single workflow — the operations / finance buyer's favorite.",
    category: "Operations",
    requiredCredentials: [],
    workflow: {
      dslVersion: "1.0",
      id: "monthly-report-pdf",
      name: "Monthly metrics report → PDF → email",
      nodes: [
        { id: "trigger", type: "schedule", config: { cronExpression: "0 9 1 * *", enabled: true } },
        {
          id: "fetch_metrics",
          type: "http",
          config: {
            url: "https://analytics.example.com/monthly-metrics",
            method: "GET",
          },
        },
        {
          id: "summarize",
          type: "ai",
          config: {
            prompt: "You are a business analyst. Given this monthly metrics payload, write a 3-paragraph executive summary covering: top movers, anomalies worth investigating, and a recommended next action. Keep the whole reply under 800 chars. Payload: {{context.fetch_metrics.output.body}}",
          },
        },
        {
          id: "render_pdf",
          type: "tool",
          config: {
            tool: "pdf.generate",
            input: {
              format: "markdown",
              filename: "monthly-report.pdf",
              title: "Monthly metrics report",
              template: "# Monthly metrics report\n\n{{summary}}\n\n---\n\n_Generated by Janusly._",
              variables: {
                summary: "{{context.summarize.output.response}}",
              },
            },
          },
        },
        {
          id: "send_report",
          type: "tool",
          config: {
            tool: "email.send",
            input: {
              to: "ops@example.com",
              subject: "Monthly metrics report",
              text: "The monthly metrics report is attached as a PDF. Summary preview:\n\n{{context.summarize.output.response}}\n\nFull PDF: {{context.render_pdf.output.result.url}}",
            },
          },
        },
      ],
      edges: [
        { from: "trigger", to: "fetch_metrics" },
        { from: "fetch_metrics", to: "summarize" },
        { from: "summarize", to: "render_pdf" },
        { from: "render_pdf", to: "send_report" },
      ],
    },
  },
  {
    id: "multi-agent-decision",
    name: "Multi-agent decision support (debate + arbiter)",
    description: "Webhook receives a decision prompt, three sequential agents debate the proposal — an optimist supports it, a skeptic critiques it, and an arbiter weighs both sides and writes the final recommendation. Showcases the multi_agent primitive — orchestration that Zapier and n8n cannot reproduce.",
    category: "AI",
    requiredCredentials: [],
    workflow: {
      dslVersion: "1.0",
      id: "multi-agent-decision",
      name: "Multi-agent decision support (debate + arbiter)",
      inputs: {
        type: "object",
        required: ["proposal"],
        properties: {
          proposal: { type: "string", description: "The decision or proposal to debate" },
        },
      },
      nodes: [
        { id: "trigger", type: "webhook", config: {} },
        {
          id: "debate",
          type: "multi_agent",
          config: {
            mode: "sequential",
            aggregation: "last",
            goal: "Decide whether to approve the proposal: {{context.trigger.output.proposal}}",
            agents: [
              {
                name: "optimist",
                goal: "List the three strongest arguments FOR this proposal: {{context.trigger.output.proposal}}",
                maxSteps: 2,
              },
              {
                name: "skeptic",
                goal: "List the three strongest arguments AGAINST this proposal, given the optimist already argued for it. Proposal: {{context.trigger.output.proposal}}",
                maxSteps: 2,
              },
              {
                name: "arbiter",
                goal: "Weigh the optimist's and skeptic's arguments and write a 3-sentence final recommendation (approve / reject / needs more info). Proposal: {{context.trigger.output.proposal}}",
                maxSteps: 2,
              },
            ],
          },
        },
        {
          id: "send_decision",
          type: "tool",
          config: {
            tool: "email.send",
            input: {
              to: "decisions@example.com",
              subject: "Decision recommendation: {{context.trigger.output.proposal}}",
              text: "The agents reached a recommendation:\n\n{{context.debate.output.finalAnswer}}\n\n— Janusly",
            },
          },
        },
      ],
      edges: [
        { from: "trigger", to: "debate" },
        { from: "debate", to: "send_decision" },
      ],
    },
  },
  {
    id: "mcp-notion-summary",
    name: "MCP Notion → AI summary → Slack",
    description: "Webhook receives a Notion page id, calls an external MCP server (alias notion-demo) to read the page, AI summarizes the contents, and Slack notifies the team. Showcases Janusly as an MCP client — operators wire a Notion MCP connection once in the admin MCP panel, then any workflow can consume it.",
    category: "AI",
    requiredCredentials: ["slack_webhook"],
    workflow: {
      dslVersion: "1.0",
      id: "mcp-notion-summary",
      name: "MCP Notion → AI summary → Slack",
      inputs: {
        type: "object",
        required: ["pageId"],
        properties: {
          pageId: { type: "string", description: "Notion page id to read" },
        },
      },
      nodes: [
        { id: "trigger", type: "webhook", config: {} },
        {
          id: "read_page",
          type: "mcp_tool",
          config: {
            connectionAlias: "notion-demo",
            toolName: "pages.read",
            input: { pageId: "{{context.trigger.output.pageId}}" },
            timeoutMs: 30000,
          },
        },
        {
          id: "summarize",
          type: "ai",
          config: {
            prompt: "Summarize this Notion page in 3-5 bullets, focused on action items and decisions. Page content: {{context.read_page.output.result}}",
          },
        },
        {
          id: "notify",
          type: "tool",
          config: {
            tool: "slack.post",
            input: {
              credential: "team-slack",
              text: ":notebook: *Notion page summary*\n\n{{context.summarize.output.response}}",
            },
          },
        },
      ],
      edges: [
        { from: "trigger", to: "read_page" },
        { from: "read_page", to: "summarize" },
        { from: "summarize", to: "notify" },
      ],
    },
  },
  {
    id: "bulk-classify-loop",
    name: "Bulk customer classify → digest email",
    description: "Webhook receives a batch of customers, the loop primitive normalizes each one into a summary line, AI classifies the entire batch in a single grouped call, and email.send delivers the digest. Showcases the loop primitive for fan-out aggregation and the scale-tier story.",
    category: "Data",
    requiredCredentials: [],
    workflow: {
      dslVersion: "1.0",
      id: "bulk-classify-loop",
      name: "Bulk customer classify → digest email",
      inputs: {
        type: "object",
        required: ["customers"],
        properties: {
          customers: {
            type: "array",
            description: "List of customers to classify",
          },
        },
      },
      nodes: [
        { id: "trigger", type: "webhook", config: {} },
        {
          id: "normalize",
          type: "loop",
          config: {
            items: "{{context.trigger.output.customers}}",
            mapping: "Customer {{item.id}} — plan={{item.plan}}, email={{item.email}}",
          },
        },
        {
          id: "classify",
          type: "ai",
          config: {
            prompt: "You are a customer-success analyst. Rank these customers by upgrade likelihood (most-likely first) and write one short reason per row. Keep the whole reply under 1200 chars.\n\nCustomers ({{context.normalize.output.count}} total):\n{{context.normalize.output.items}}",
          },
        },
        {
          id: "send_digest",
          type: "tool",
          config: {
            tool: "email.send",
            input: {
              to: "success@example.com",
              subject: "Bulk customer classification digest ({{context.normalize.output.count}} customers)",
              text: "Janusly classified {{context.normalize.output.count}} customers:\n\n{{context.classify.output.response}}",
            },
          },
        },
      ],
      edges: [
        { from: "trigger", to: "normalize" },
        { from: "normalize", to: "classify" },
        { from: "classify", to: "send_digest" },
      ],
    },
  },
];
