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
grep -F 'die "$profile qualification requires a clean worktree' "$root/scripts/qualification-local.sh" >/dev/null
grep -F 'sourceIntegrityVerified:$sourceIntegrityVerified' "$root/scripts/qualification-local.sh" >/dev/null
grep -F 'candidate source changed while qualification was running' "$root/scripts/qualification-local.sh" >/dev/null
grep -F 'worktree add --quiet --detach "$qualification_snapshot" "$qualification_commit"' \
  "$root/scripts/qualification-local.sh" >/dev/null
grep -F 'JANUSLY_QUALIFICATION_SOURCE_COMMIT="$qualification_commit"' \
  "$root/scripts/qualification-local.sh" >/dev/null
grep -F '"$qualification_snapshot/scripts/qualification-local.sh" "$profile"' \
  "$root/scripts/qualification-local.sh" >/dev/null
grep -F "':(exclude)web/node_modules'" "$root/scripts/qualification-local.sh" >/dev/null
[[ $(grep -c 'qualification_source_status' "$root/scripts/qualification-local.sh") -eq 3 ]] || {
  echo "immutable source checks do not consistently exclude only the harness dependency mount" >&2
  exit 1
}

fixture=$(mktemp -d "${TMPDIR:-/tmp}/janusly-qualification-dirty.XXXXXX")
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/scripts" "$fixture/web/node_modules/.bin"
cp "$root/scripts/qualification-local.sh" "$fixture/scripts/qualification-local.sh"
touch "$fixture/web/node_modules/.bin/playwright"
chmod +x "$fixture/web/node_modules/.bin/playwright"
git -C "$fixture" init -q
git -C "$fixture" config user.name Janusly
git -C "$fixture" config user.email janusly@example.invalid
printf 'frozen\n' >"$fixture/candidate.txt"
git -C "$fixture" add candidate.txt scripts/qualification-local.sh
git -C "$fixture" commit -qm frozen
printf 'changed\n' >>"$fixture/candidate.txt"
for immutable_profile in load pagerduty; do
  error_file="$fixture/$immutable_profile.err"
  if CONFIRM=reset "$fixture/scripts/qualification-local.sh" "$immutable_profile" \
    >"$fixture/$immutable_profile.out" 2>"$error_file"; then
    echo "$immutable_profile accepted a dirty qualification source" >&2
    exit 1
  fi
  grep -F "$immutable_profile qualification requires a clean worktree" "$error_file" >/dev/null
done
rm -rf "$fixture"
trap - EXIT
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
