# Demo: Inspect and validate a failed workflow

**Template:** `failed-workflow-recovery` in
`internal/httpapi/assets/templates.json`

**Audience:** Operators evaluating native workflow recovery

**Scope:** Provider-free, disposable local environment. This is not a live
billing recovery, a timed customer result, or proof of an external effect.

## Prepare safely

Use a fresh PostgreSQL 18-backed Janusly environment with no billing or email
credentials and no live write targets. Do not use a production tenant. The
sample payload is synthetic:

```json
{"customer":"leah@example.com","amountUsd":49}
```

The template's `charge` node is an HTTP `POST` to
`https://billing.example.com/charges` with an intentionally unbound
`{{secret.BILLING_API_KEY}}`. Its write path also lacks an upstream approval.
These are **two separate findings**: the missing secret causes the demonstrated
run failure, while readiness flags the approval boundary. Adding approval
alone does not supply a credential or prove that billing will succeed.

## Walk through evidence, not a promised AI fix

1. Load the template, start a run, and deliver the synthetic webhook payload.
   Observe the failed `charge` node and its dead-letter entry in Recovery
   Queue. The specialized `web/e2e/demo-templates.spec.ts` test proves this
   failure path and the separate readiness issue.
2. Inspect the error and the workflow snapshot. Distinguish *a request was
   attempted* from *a downstream effect happened*. No billing receipt exists
   in this provider-free environment.
3. Request a patch without an Anthropic key. The API returns `mode: fallback`
   with the **original workflow unchanged**, not a generated approval or
   secret swap. The recovery dialog may present that envelope, but it is not
   a repair. `internal/httpapi/aipatch_integration_test.go` pins this behavior.
4. Validate the unchanged workflow in the sandbox. It fails again at the
   unresolved node; the red result is correct and should prevent treating a
   non-fix as success. The provider-free `web/e2e/recovery-loop.spec.ts` covers
   this negative case.
5. To demonstrate the mechanics without an external effect, make a **manual
   copy** that replaces `charge` with a `noop` node of the same ID. Validate
   the copy in the sandbox, then replay only in the disposable environment.
   The specialized recovery-loop test proves the run and dead-letter entry
   settle. A `noop` deliberately performs **no charge**: its green run is an
   engine/replay demonstration, not a verified billing outcome.

Do not claim that the template automatically produces `add_approval` and
`swap_secret_ref`, that a sandbox pass authorizes production, that email was
sent, or that health/cost savings improved. A configured model can return
suggestions, but their content is not deterministic and each candidate still
requires human review, readiness checks, sandbox validation, and an
independent result check. A genuine billing pilot requires a separately
approved sandbox endpoint, bound credential, approval topology, effect limits,
and provider receipt; it is outside this provider-free demo.

## What to measure in a study

Ask the participant to locate the failure, explain the missing-secret versus
approval findings, choose a safe next step, and identify what evidence would
verify a real outcome. Use the moderated [usability protocol](../usability-testing.md)
for the three-user task and keep times, assistance, and observations private.
Do not quote rehearsal timings or invented before/after metrics as customer
evidence. The supported claim today is narrower: Janusly exposes native
failure evidence and a validation/replay path; an external result must be
checked separately.
