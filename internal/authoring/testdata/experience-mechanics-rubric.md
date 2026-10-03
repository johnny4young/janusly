# Experience decision mechanics rubric

This locked corpus is synthetic contract evidence, not a model evaluation,
reviewed business success label or real-world reuse-precision claim.

- Exact, readable, retained same-tenant version and identical full structured
  brief: REUSE. Cross-tenant poison rows do not compete for authority.
- Same exact match plus an explicit workflow-name edit: ADAPT. No authority,
  configuration, graph, trigger, approval, effect or secret may change.
- Empty registry, unequal effects/approvals or no candidate available as of the
  supplied timestamp: GENERATE. This classification makes no provider call.
- Incomplete intent, missing consent, ambiguous exact sources, truncated candidate
  set or unsupported/poisoned edits: ESCALATE. No source reference is admitted.

There are 60 cases per mode, 120 per language and five workflow families.
Development contains the first three families (144 cases); qualification holds
out approval drafts and incident summaries (96 cases), including all variants
and both languages. Do not move sibling examples between splits. Keys preserve
all ten ordered brief fields and literal machine identifiers. Labels are stated
in each case and checked by deterministic policy independently of fixture-provider
output. Rules-provider behavior is a separate consumer, not presumed here.

`experience-mechanics-manifest.json` freezes IDs through the corpus file hash,
counts, families and splits. Changes require explicit rubric and manifest review;
never relabel a failing case just to make a new decision policy pass.

Run from the repository root:

```sh
go run ./cmd/authoringcheck internal/authoring/testdata/experience-mechanics.json
```

The report says contract mechanics only. No source graph is loaded, generated,
mutated, saved or run. No embedding/completion/network/DB path is available.
