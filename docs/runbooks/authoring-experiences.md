# Register and review an authoring example

Use an explicitly registered saved workflow version as a source for a new,
unsaved draft. These steps do not save, execute or approve a workflow.

## Prerequisites

An authorized administrator must already have enabled the process gates
`JANUSLY_AUTHORING_EXPERIENCE_ENABLED=true` and `JANUSLY_MEMORY_ENABLED=true`,
and set `JANUSLY_AUTHORING_EXPERIENCE_MODE=review` for source-bearing proposals.
The mode alone does not enable the feature. The organization must explicitly
consent through `ai.authoringExperienceEnabled=true`, `memory.enabled=true`
and the `workflow_vector` entry in `memory.allowedKinds`.

Use an editor or administrator account with existing AI authoring and workflow
read/write permissions,
and a saved workflow with a compatible immutable version in that organization.
Do not enable consent merely to dismiss an error. See [configuration](../configuration.md)
and [experience policy](../architecture/experience-authoring.md) for the gates.
No new model or completion key is required for REUSE/ADAPT; GENERATE still uses
the ordinary permissions, budget, provider and deterministic fallback path.

## Register one exact source

1. Open the saved workflow's version history. **Registered authoring examples**
   appears only after the consented, authorized registry read succeeds. If it is
   absent, check the prerequisites rather than granting consent automatically.
2. In **Saved source version**, choose the exact saved version to retain as an
   example. Describe its complete intent in **Example intent**, without secrets.
   The current canvas is not submitted as the saved source.
3. Select **Compile example intent** and review the structured brief, including
   effects, approvals and missing-detail questions. If the brief is incomplete,
   update the intent and compile again; registration remains unavailable.
4. Select **Register example** explicitly. Confirm the listed version number and
   immutable version ID. Registration preserves that source; it is not evidence
   that any business effect succeeded. Outcome evidence remains **unknown**.

## Review a source-bearing proposal

1. In AI Studio, describe the same complete structured intent and select
   **Compile intent brief**. Review capability bindings, then select
   **Build proposal preview** explicitly. Matching is exact, not semantic search;
   a different intent need not select the saved example.
2. Review the classification, reason/policy and exact source version. REUSE copies
   an eligible source; ADAPT only changes its explicitly requested name. GENERATE
   uses the existing authoring path. ESCALATE requires more review and is not
   applicable to the canvas. A registration or rules label grants no approval.
3. For a name-only adaptation, edit **Optional copied workflow name** (at most
   **200 UTF-8 bytes**) and build another preview. Editing the field invalidates
   the previous proposal; it does not change a reviewed graph or submit work.
4. Select **Apply proposal to draft** only after reviewing the graph and diff.
   Apply re-reads the catalog and revalidates the exact reviewed source/receipt.
   A revoked, deleted, expired, incompatible or changed source blocks copying;
   it does not substitute a newly generated proposal. Follow the confirmation
   if the canvas contains unsaved work.
5. Inspect the resulting canvas: it is still **unsaved**. Save, validation and Run
   are separate authorized actions, not consequences of registration or Apply.

## Withdraw an example or handle unavailable evidence

Use **Withdraw example** for the listed saved version. Withdrawal removes its
eligibility without deleting the saved workflow. Re-granting consent does not
restore a revoked registration; a later registration must be explicit.

If an operation reports that the example is unavailable, check the current
organization, permissions, consent and exact saved source before retrying. If
review is stale, build a new preview explicitly; do not assume an old response
owns the current canvas. A request already delivered to the server is not
proven cancelled merely because the browser discarded its result.

In `off` mode, ordinary authoring remains unchanged. `shadow` observes rules but
returns the ordinary proposal without resolving/applying a source or adding
provider calls; source-bearing review requires `review`. These are technical
boundaries, not claims of model quality, verified outcomes or human acceptance.
