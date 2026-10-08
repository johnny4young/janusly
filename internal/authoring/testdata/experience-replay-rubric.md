# Frozen chronological replay rubric

These 42 synthetic cases (21 scenarios in each of EN/ES) test mechanism only.
They do not identify a real tenant, successful business effect or human label.
The catalog is a frozen snapshot of the builtin builder without tenant state.
The original 240-case decision corpus and its manifest remain unchanged.

- A complete exact brief and one same-tenant available registration require
  REUSE. An explicit workflow-name edit alone requires ADAPT. Both privately
  copy the exact fixture source through canonical parsing, binding and validation.
- Future registration/version timestamps, exact expiration/revocation/deletion
  boundaries, foreign sources or no registration yield GENERATE/no_exact_match.
- Revocation/deletion after the replay instant do not change the past. Twenty
  later registrations must not consume past top-K or set its truncation sentinel.
- Missing past consent or a withdrawal at the replay instant requires ESCALATE.
  Future consent cannot grant past admission. Current configuration is not queried.
- Two exact candidates require ambiguity review. More than five eligible
  candidates disclose truncation and require review, never arbitrary first-row reuse.
- Unsupported credential adaptation requires review. Canonical recipe precedence
  remains a policy input obtained from the existing recognizer in the runtime;
  this fixture tests precedence, not natural-language recipe recognition.
- Poisoned source identity or a write-capable graph inconsistent with the brief
  invalidates the selected reuse at the independent copy boundary. It must not
  request generation or silently repair the source.
- A cancelled case has no proposal, artifact or generation request. No caller
  cancellation is translated into a second path.

Expected artifact statuses are `copied`, `invalidated`, `not_requested` or
`cancelled`. The report includes all outcomes and denominators; invalidated
reuse and escalations are not calls saved. Actual logical provider calls and SDK
transport requests are zero because this runner has no provider client.
Readability/compatibility facts are frozen for each case's catalog/as-of instant;
this is not a reconstruction of historical authorization from a live database.
