#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

bash -n "$root/scripts/qualification-local.sh"
output=$(JANUSLY_QUALIFICATION_PROJECT=janusly-qualification-selftest-1 \
  "$root/scripts/qualification-local.sh" selftest)
jq -e '
  .project == "janusly-qualification-selftest-1" and
  .authProject == "janusly-qualification-auth" and
  .origin == "http://127.0.0.1:7310" and
  .supabaseConfigured == false
' <<<"$output" >/dev/null

configured=$(JANUSLY_QUALIFICATION_SUPABASE_STATUS_JSON='{"ANON_KEY":"publishable-test","SERVICE_ROLE_KEY":"secret-test"}' \
  "$root/scripts/qualification-local.sh" selftest)
jq -e '.supabaseConfigured == true and (has("anonKey") | not) and (has("serviceRoleKey") | not)' \
  <<<"$configured" >/dev/null

if JANUSLY_QUALIFICATION_PROJECT=janusly "$root/scripts/qualification-local.sh" selftest >/dev/null 2>&1; then
	echo "selftest accepted the ordinary development project" >&2
	exit 1
fi
if JANUSLY_QUALIFICATION_PROJECT=janusly-qualification-app \
  "$root/scripts/qualification-local.sh" selftest >/dev/null 2>&1; then
	echo "selftest accepted the historical shared qualification project" >&2
	exit 1
fi
if JANUSLY_QUALIFICATION_APP_PORT=abc "$root/scripts/qualification-local.sh" selftest >/dev/null 2>&1; then
  echo "selftest accepted an invalid port" >&2
  exit 1
fi
if "$root/scripts/qualification-local.sh" unknown >/dev/null 2>&1; then
  echo "selftest accepted an unknown profile" >&2
  exit 1
fi

help=$("$root/scripts/qualification-local.sh" --help)
grep -F "pagerduty | load | all" <<<"$help" >/dev/null
grep -F "load and flagship PagerDuty profiles are intentionally" <<<"$help" >/dev/null
grep -F "pagerduty qualification requires a clean worktree" "$root/scripts/qualification-local.sh" >/dev/null
grep -F 'sourceIntegrityVerified:$sourceIntegrityVerified' "$root/scripts/qualification-local.sh" >/dev/null
grep -F 'PagerDuty candidate source changed while qualification was running' "$root/scripts/qualification-local.sh" >/dev/null
grep -F 'worktree add --quiet --detach "$qualification_snapshot" "$qualification_commit"' \
  "$root/scripts/qualification-local.sh" >/dev/null
grep -F 'JANUSLY_QUALIFICATION_SOURCE_COMMIT="$qualification_commit"' \
  "$root/scripts/qualification-local.sh" >/dev/null
grep -F "':(exclude)web/node_modules'" "$root/scripts/qualification-local.sh" >/dev/null
[[ $(grep -c 'pagerduty_source_status' "$root/scripts/qualification-local.sh") -eq 3 ]] || {
  echo "PagerDuty source checks do not consistently exclude only the harness dependency mount" >&2
  exit 1
}
grep -F 'failed to write complete evidence summary' "$root/scripts/qualification-local.sh" >/dev/null
grep -F 'failed to capture final diagnostics' "$root/scripts/qualification-local.sh" >/dev/null
grep -F 'project_has_resources && die "refusing pre-existing resources for project $project"' \
  "$root/scripts/qualification-local.sh" >/dev/null
grep -F 'if ((owns_app_project)); then' "$root/scripts/qualification-local.sh" >/dev/null
if grep -F 'compose ps --format json >"$evidence_root/logs/compose-ps.json" 2>/dev/null || true' \
  "$root/scripts/qualification-local.sh" >/dev/null; then
  echo "qualification diagnostics must not swallow compose failures" >&2
  exit 1
fi
for contract_test in \
  AuthoringContractFirstVersionedAliases \
  ConcurrentWorkflowSavesSerializeWithoutLostVersions \
  CycleDetectionHandlesDeepGraphsIteratively \
  DecodeBodyErrorsAreNeverDiscarded \
  DecodeCompileWorkflowBriefRequestPreservesOmissionAndRejectsNull \
  DecodeWorkflowProposalRequestPreservesOmissionAndRejectsNull \
  EveryContractClientOperationMatchesAllSources \
  EveryHTTPInternalErrorIsRedacted \
  EveryV1RouteIsDeclaredInTheManifest \
  EveryWebPathResolvesToARegisteredRoute \
  ExternalTriggerInternalErrorsAreRedacted \
  GovernedSemanticRecoveryLifecycle \
  GovernedMutationManifestsRejectUnknownProperties \
  GovernedRecoveryInternalErrorsAreRedacted \
  InsertTriggerEventConcurrentDeterministicIdentityConverges \
  MCPResponseAndExpectedErrorsAreGloballyBounded \
  McpWorkflowSaveUsesCanonicalAtomicEngineOperation \
  OperatorBriefDoesNotCrossReadPermissionBoundaries \
  ParsePersistedWorkflowSloReusesTheClosedWriteContract \
  ParseRejectsInvalidAndExcessiveInputSchemas \
  ParseSemanticRecoveryCandidateAllowsOnlyBoundedManualFollowUp \
  ParseSemanticRecoveryValidationRequiresExactEnvelope \
  ReachableNodesWithoutPreservesOriginalRootBoundary \
  RecoveryCandidatesRequestPreservesWireIntent \
  RecoveryCaseDetailProjectsOnlyCurrentBoundedApproval \
  RecoveryCaseDetailRetainsFoundationsAndNewestBoundedEvidence \
  RecoveryCaseReads \
  RecoveryContractValidation \
  RollbackReadinessStartsOnlyAfterFirstSavedVersion \
  SecretStoreDetailedResolutionClassifiesStoreFailure \
  SecretStoreRootKeyPosture \
  SemanticOutcomeInterception \
  SemanticGuardIssuesUseStableEffectOrder \
  WorkflowDocumentCanonicalizesKnownContractFields \
  WorkflowDocumentDefaultsMetadataAndRejectsExplicitNull \
  WorkflowDocumentRejectsNestedNullsAndMalformedUI \
  WorkflowHealthFailsClosedOnMalformedPersistedSlo \
  WorkflowHealthTreatsAbsentPersistedSloAsUndeclared \
  WorkflowParseRejectsRecoveryWireDriftAndNormalizesStrings \
  WorkflowRecoveryWireMatchesStrictSourceContract \
  WorkflowRollbackAtomicallyRestoresSchedulesAndReliability \
  WorkflowSaveManifestPreservesAuthorityBoundary \
  WorkflowSaveTopLevelContractIsStrict \
  WorkflowSaveUpstreamCarrierValidation \
  WorkflowSloMutationRequiresExplicitReplacement \
  WorkflowSloMutationSharesVersionSerializationLock \
  WorkflowSavePersistsCanonicalSnapshotAndCarriesReliability \
  WorkflowProposalSkipsProviderForStaleCatalog \
  WorkflowReadSurfaces \
  McpPermissionDenialsCannotConsumeAuthorizedToolBucket; do
  grep -F "$contract_test" "$root/scripts/qualification-local.sh" >/dev/null
done

echo "qualification harness selftest passed"
