# 2026-10 contract truth program

Follow-up to the September deep-review remediation. Three debts remain that
the remediation could only patch: browser wire validators that re-encode
server policy, a dead-code inventory that is still measured by hand, and a
price catalog that is trusted rather than checked. Each wave lands as its own
PR after a green `make verify`; waves are independent unless noted.

## Problem 1 — the browser rejects what the server says

The API contract already has one source of truth: `internal/contract`
(48 routes, closed JSON schemas) renders `contract/openapi.json`, which
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

### Wave 3 — shrink the hand-written contracts to UI invariants

- Module by module, delete the shape and policy rules from the seven contract
  modules and the two inline parsers; keep only kind-2 invariants, each with a
  one-line comment naming the component that needs it.
- Add a ratchet test (`web/scripts/wire-policy-ratchet.test.mjs`) that counts
  numeric literals in `web/src/lib/*contract*.ts` and `health-delta.ts` and
  fails when the count grows. Start at today's count, lower it each wave.
- Update `docs/architecture/api-contract.md` with the rule: the browser
  validates shape from the manifest and never policy.
- Done: ratchet at zero for policy literals; no `Number.isSafeInteger(...) &&
  value <= N` left outside generated code.

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
  `go run ./cmd/pricing --json`. Add it to `qualify-local`, never to CI.
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

Waves 4 and 5 can ship first and in parallel. Waves 1–3 are the program's
core and should ship in order, one PR each.
