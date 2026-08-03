# Go release-candidate evidence

This procedure turns local validation, Git provenance, and external rollout
receipts into one fail-closed manifest. It does not push a branch, open a pull
request, deploy a runtime, or change traffic.

## Local review gate

Start from a clean checkout after fetching `origin`:

```bash
make release-review
```

The command executes, without reusing historical success claims:

- root lint, script tests, contract drift, build, and unit tests;
- the root PostgreSQL 18 integration lane;
- the complete Go CI and isolated PostgreSQL 18 race lanes;
- five co-scheduled PostgreSQL 18 A/B pairs, each with isolated candidate and
  frozen-baseline instances/databases, evaluated as one exact-candidate
  campaign;
- the isolated Node → Go → Node → Go queue-ownership rehearsal; and
- a final commit, tree, and worktree-cleanliness check.

It writes ignored evidence under `../artifacts/`:

- `go-release-checks.json` — command, exit status, and duration per local gate;
- `go-queue-handoff-evidence.json` — exact-tree queue round-trip receipt;
- `go-benchmark-campaign.json` and `.md` — per-pair candidate/baseline metrics,
  paired medians, p95 and worst ratios, variation, and campaign verdict;
- `go-release-candidate.json` — machine-readable aggregate manifest; and
- `go-release-candidate.md` — operator-readable summary.

The A/B policy fails on any error, a paired median regression beyond 25%,
ratio variation above 30%, or a severe 50% regression repeated in at least two
of the five pairs. One isolated severe pair remains in the report as `WARN`;
it cannot impersonate a repeatable regression or be silently discarded.

The manifest also records the candidate commit/tree, fetched base refs, frozen
Node oracle, PostgreSQL 18 policy, runtime image references, and SHA-256 hashes
for the Node/Go contracts, lockfiles, audit, cutover runbook, benchmark
baseline/harness, and migration dashboard. A dirty tree, stale receipt,
unintegrated `origin/main` patch, moved Node oracle, or failed local check
blocks review readiness.

## External production gate

Local review readiness is not production readiness. The exact same commit and
tree still require separately captured receipts for:

1. reviewed remote integration;
2. remote CI on the reviewed head;
3. the exact-head opt-in qualification profiles;
4. write-safe shadow comparison;
5. the global work-plane cutover;
6. gradual canary progression with stop thresholds; and
7. an executed rollback rehearsal.

List the closed qualification catalog with `pnpm qualification:list`. Execute
one profile, a comma-separated subset, or every no-credit local profile with:

```bash
pnpm qualification:run -- --profiles=all_local --confirm-destructive
```

The runner emits `artifacts/go-qualification.json` and separate evidence
directories, stops after the first failed profile, runs each profile's cleanup,
and rejects a changed source tree. The real-provider profile is excluded from
`all_local`; it additionally requires `--confirm-provider-cost`, a direct
Anthropic key, and the existing bounded budget environment variable.

The manual `Qualification profiles` GitHub workflow exposes the same closed
catalog. Its weekly schedule runs only the cheap Supabase configuration drift
probe: `pnpm qualification:supabase-pg18` remains green while the pinned CLI
rejects PostgreSQL 18 and deliberately turns red as soon as the CLI accepts it,
forcing removal and requalification of the PostgreSQL 17 Auth-lab exception.

[`EXTERNAL-GATES.md`](EXTERNAL-GATES.md) defines the machine-validated evidence
contract and record-only commands for all seven gates. Shadow evidence is
strictly read-only. It cannot authorize a per-tenant or overlapping mutation
plane; Node-to-Go work-plane ownership moves globally at the cutover gate.

`make release-production-check` only evaluates those receipts. It performs no
remote or traffic mutation and fails while any external gate is missing,
failed, or belongs to another candidate.

Never edit a receipt to make a verdict green. Rerun the owning gate against the
exact candidate. Preserve `nodejs-legacy` until the production rollback gate
and post-cutover soak both pass.
