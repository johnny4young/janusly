# 2026-10 contract truth program

Follow-up to the September deep-review remediation. Three debts remain that
the remediation could only patch: browser wire validators that re-encode
server policy, a dead-code inventory that is still measured by hand, and a
price catalog that is trusted rather than checked. The waves shipped together
as one PR with one commit series, each commit green on its own; waves are
independent unless noted.

## Problem 1 — the browser rejects what the server says

The API contract already has one source of truth: `internal/contract`
(56 routes, closed JSON schemas) renders `contract/openapi.json`, which
generates `web/src/lib/api-types.generated.ts`. The remediation added
hand-written runtime guards on top of those types (`list-contract`,
`run-status-contract`, `dead-letter-contract`, `recovery-patch-contract`,
`recovery-case-contract`, `authoring-contract`, `health-delta`, plus inline
parsers in `WorkflowRolloutPanel` and `WorkflowRecoveryQualification`). They
mix three kinds of rules:

1. Shape: types, nullability, enums, required keys. This belongs in the
   manifest and should be generated, not typed twice.
2. UI invariants: cross-field facts a component depends on (a delta is a
   record iff `hasEnoughData`, a page has unique ids). These are legitimate
   client preconditions and stay, documented as such.
3. Server policy: `MinRunsForDelta`, sample caps, page sizes, `maxItems`,
   string length limits. The client cannot know when these change, so every
   copy is a latent "malformed response" outage.

The remediation removed the worst of kind 3. The pattern that produced it is
still open: 21 route responses in the manifest are still `type: object`
placeholders, so the only way the browser could validate them was by hand.

### Wave 1 — close the manifest

- Replace the 21 open `object` responses with closed schemas built from the
  typed Go views (`internal/httpapi/views.go`, `run_views.go`,
  `TemplateCatalogView`, ...). Add a manifest test that fails when any route
  response is an open object unless it is listed in a short allowlist with a
  reason.
- Generalize `TestDLQDetailManifestMatchesWire` into a table-driven harness:
  every `*Core` handler's rendered JSON is validated against its manifest
  schema in the unit lane. Server tests, not browser guards, are where a wire
  change is caught.
- Done: allowlist empty or justified; every route has a wire-conformance test;
  `make generate` drift stays zero.

### Wave 2 — generate the browser guards

- Extend `cmd/contract` to emit `web/src/lib/api-guards.generated.ts`: one
  tree-shakeable `is<Operation>Response` per route, derived from the closed
  schema (types, enums, nullability, required keys). No schema library at
  runtime: the artifact budget has 0.8 KB of headroom and a validator library
  would blow it.
- `contractApi` validates through the generated guard for its operation key
  and raises the one existing `api.error.malformedResponse` path. Callers stop
  calling module-level `parse*` functions for shape.
- Done: guard output is part of `make generate`; the worst-locale and
  artifact budgets pass without a rebase, or are rebased once by the measured
  cost.
- Landed: shared manifest fragments became `components/schemas` entries
  referenced by `$ref` (`contract/openapi.json` 627 → 238 KB,
  `api-types.generated.ts` 81 → 48 KB). `api-guards.generated.ts` carries 97
  component and 56 operation guards; 21 operations are adopted at their
  `contractApi` call sites. The recovery-case mutations (diagnose, candidates,
  validate, approve, apply) are not guarded: a guard failure after the server
  committed the mutation would report a failure and skip the case reload.
- Budget: the adopted guards measured 3,374 gzip bytes (artifact
  618,497 → 621,871 B, worst locale 573,597 → 576,971 B, all of it in
  `app-workspace.js`). The caps were rebased once by that cost: artifact
  605 → 608.3 KiB, worst single locale 560.5 → 563.8 KiB.

### Wave 3 — shrink the hand-written contracts to UI invariants

- Module by module, delete the shape and policy rules from the seven contract
  modules and the two inline parsers; keep only kind-2 invariants, each with a
  one-line comment naming the component that needs it.
- Add a ratchet (`web/scripts/check-wire-policy.mjs`, in `pnpm lint`) that
  fails on numeric literals in the hand-written readers unless a
  `// wire-policy: <reason>` marker explains them.
- Update `docs/architecture/api-contract.md` with the rule: the browser
  validates shape from the manifest and never policy.
- Done: ratchet at zero for policy literals; no `Number.isSafeInteger(...) &&
  value <= N` left outside generated code.
- Landed: the generator emits one module per guard with no barrel, so a lazy
  panel's guard ships in its own chunk. The readers delegate shape to their
  generated guard and keep only commented UI invariants; a guard failure raises
  `MalformedResponseError`, which panels map back to their own unavailable
  copy. `check-duplicate-guards` now owns every `guards.ts` export and
  `check-raw-v1-reads` also rejects raw `api()` calls on manifest operations
  (older raw mutations sit in a shrinking baseline).

## Problem 2 — dead code measured by hand

`go run golang.org/x/tools/cmd/deadcode ./cmd/api ./cmd/mcp` lists five
unreachable functions today (down from 21 at the original review):

| Function | Reality | Action |
|---|---|---|
| `internal/ai.StaticModelPrices` | Used by `cmd/pricing`, a third production root the inventory did not include | Add `./cmd/pricing ./cmd/contract` to the roots |
| `internal/auth.DefaultRoleHasPermission` | Test-only (catalog, registry, security review tests) | Move to a same-package `_test.go` helper |
| `internal/httpapi/scim.SignWebhookHeader` | Test-only signer for the verifier | Move next to the SCIM tests |
| `internal/observability.SweepNames` | Test-only (wiring, rules contract, e2e) | Keep exported, allowlist with reason, or move to `export_test.go` |
| `internal/secretstore.ResetForTests` | Test-only reset used by 12 integration tests | Replace with per-test isolation or allowlist with reason |

### Wave 4 — make the inventory a gate

- `make deadcode`: runs the tool over all production roots and diffs against
  `scripts/deadcode-allowlist.txt`. New entries fail; removed entries must be
  deleted from the allowlist in the same change.
- Wire it into the Backend CI lane after `go vet`.
- Resolve the five entries above; the allowlist should end with at most the
  two documented test seams.
- Frontend: the September sweep removed 55 unused exports with a one-off
  script; add the same ratchet for `web/src` unused exports so the count
  cannot grow.

## Problem 3 — a price catalog that is trusted, not checked

Checked on 2026-09-24 against the vendor pricing page: every Anthropic entry
in `internal/ai/pricing.go` matches (Haiku 4.5 1/5, Sonnet 4.5 and 4.6 3/15,
Sonnet 5 2/10 as the retained standard rate, Opus 4.5 through 5 5/25,
Fable 5 and 5.1 10/50). The remediation's Sonnet 5 correction was right.
What is missing is a way to know the next time it drifts.

### Wave 5 — keep the catalog honest

- `scripts/pricing-check.sh` (opt-in, network): fetch the vendor pricing page,
  extract the per-model input/output rates, and diff them against
  `go run ./cmd/pricing --json`. Run it by hand (`make pricing-check`); its
  offline self-test joins `qualify-local-selftest`, never CI.
- A unit test that fails when `ModelPricingSnapshotDate` is older than 120
  days, with a message pointing at the script. Re-verifying is then a dated
  one-line change.
- Record each verification in `docs/architecture/ai-pipeline.md` next to the
  snapshot date so the audit trail is in the repository, not in a PR body.

## Order and size

| Wave | Depends on | Size | Risk |
|---|---|---|---|
| 1 close the manifest | — | M | Low: server-only, tests catch drift |
| 2 generate guards | 1 | L | Bundle budget; keep guards tree-shakeable |
| 3 shrink contracts | 2 | M | Behavior change only where a policy rule was wrong |
| 4 dead-code gate | — | S | None |
| 5 pricing check | — | S | None |

Waves 4 and 5 could ship first and in parallel. Waves 1–3 are the program's
core and shipped in order, within the same PR and commit series as 4 and 5.

## Status

Complete. One PR, one commit series on `codex/contract-truth-program`.

| Wave | Status | Commits |
|---|---|---|
| 4 dead-code gate | done | `a5111ff8`, hardened in `2d30f0a2` |
| 5 pricing check | done | `4dc8e3d4`, hardened in `2d30f0a2` |
| 1 close the manifest | done | `a6e07762`, `014b5649` |
| 2 generate guards | done | `4b671193`, `124383e2` |
| 3 shrink contracts | done | `d23c6403`, `32caa367`, and the ratchet commit that adds this section |

Measured at the end of the program:

- Manifest: closed route responses 11 → 56 of 56, with 99 shared schema
  components.
- Generated guards: 56 operation and 97 component modules (the two envelope
  schemas have no guard).
- Adoption: operations validated by their generated guard 21 → 35. Wave 3 moved
  15 call sites from raw `api()` to `contractApi` (12 with a guard, 3 typed
  mutations that stay unguarded); 11 older raw mutation calls remain in
  `RAW_OPERATION_BASELINE`, which may only shrink.
- Dead-code allowlist: 2 documented test seams.

Wire-policy literals (numeric literals other than 0, 1 and -1) per reader, at
the start of Wave 3 and after it. After Wave 3 every remaining literal carries a
`// wire-policy:` reason, so the unannotated count is 0 everywhere:

| Reader | Before | After (annotated) |
|---|---:|---:|
| `recovery-case-contract.ts` | 27 | 1 (validate-then-approve revision step) |
| `recovery-patch-contract.ts` | 16 | 1 (pinned playbook confidence) |
| `authoring-contract.ts` | 12 | 1 (input-schema amplification bound shared with Go) |
| `list-contract.ts` | 3 | 0 |
| `health-delta.ts` | 3 | 0 |
| `dead-letter-contract.ts` | 1 | 0 |
| `run-status-contract.ts` | 0 | 0 |
| `recovery-home-sections.ts` | 0 | 0 |
| `WorkflowRolloutPanel.tsx` | 18 | 10 (form defaults and bounds, percent, two-version minimum, icon size) |
| `WorkflowRecoveryQualification.tsx` | 4 | 1 (failures listed on the card) |
| Total | 84 | 14 annotated, 0 unannotated |

Bundle (gzip bytes; caps in KiB):

| Point | Artifact | Worst single locale | Caps |
|---|---:|---:|---|
| Before the program | 618,497 | 573,597 | 605 / 560.5 |
| After Wave 2 | 621,871 | 576,971 | 608.3 / 563.8 |
| After Wave 3 | 619,475 | 574,575 | 605.9 / 562.0 |

Per-guard modules moved the lazy-only guards out of the eager `app-workspace`
chunk (−838 B there; `OperationsPage` +515 B and `FailureClustersCard` +129 B
at that step), and removing the hand-written validators recovered the rest.
The artifact now carries 35 adopted guards for 978 B more than before the
program.
