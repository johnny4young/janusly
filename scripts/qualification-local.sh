#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
profile=${1:-all}
qualification_commit=$(git -C "$root" rev-parse HEAD)
qualification_tree=$(git -C "$root" rev-parse 'HEAD^{tree}')
project=${JANUSLY_QUALIFICATION_PROJECT:-janusly-qualification-${UID:-0}-$$}
auth_project=janusly-qualification-auth
app_port=${JANUSLY_QUALIFICATION_APP_PORT:-7310}
postgres_port=${JANUSLY_QUALIFICATION_POSTGRES_PORT:-7438}
metrics_port=${JANUSLY_QUALIFICATION_METRICS_PORT:-7464}
credential_master_key=0a6ee99978435f3e242e19aa61839045c6c1a5f1f5e63558f9d40706702570c7
origin="http://127.0.0.1:${app_port}"
supabase_public_url=http://127.0.0.1:7431
supabase_internal_url=http://host.docker.internal:7431
supabase_home=${JANUSLY_SUPABASE_HOME:-/tmp/janusly-supabase-home-${UID}}
supabase_bin="$root/web/node_modules/.bin/supabase"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
evidence_root=${JANUSLY_EVIDENCE_DIR:-$root/output/qualification/$stamp/$profile}
status=failed
started=0
owns_app_project=0
uses_supabase=1
janusly_env=production
allow_dev_auth_headers=false
browser_connect_origins=$supabase_public_url
runtime_supabase_url=$supabase_internal_url
runtime_supabase_service_role_key=${SUPABASE_SERVICE_ROLE_KEY:-}
build_supabase_url=$supabase_public_url
build_supabase_anon_key=${VITE_SUPABASE_ANON_KEY:-}
otel_exporter=
source_integrity=true
qualification_snapshot=

usage() {
  cat <<'EOF'
usage: scripts/qualification-local.sh PROFILE

PROFILE: clean | identity | security | tenant | recovery | pagerduty | load | all | selftest

Destructive profiles require CONFIRM=reset. They may remove only the fixed
janusly-qualification-auth Supabase project and the uniquely owned
janusly-qualification-<uid>-<pid> Compose project created by this invocation.
Pre-existing Compose resources are refused, never adopted.
The load and flagship PagerDuty profiles are intentionally excluded from all
and must be selected explicitly.
EOF
}

die() {
  printf 'qualification: %s\n' "$*" >&2
  exit 2
}

validate_configuration() {
  case "$profile" in
    clean|identity|security|tenant|recovery|pagerduty|load|all|selftest) ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown profile: $profile" ;;
  esac
	[[ "$project" =~ ^janusly-qualification-[a-z0-9-]+$ ]] ||
		die "JANUSLY_QUALIFICATION_PROJECT must start with janusly-qualification-"
	[[ "$project" != janusly-qualification-app ]] ||
		die "refusing the historical shared qualification Compose project"
  for port in "$app_port" "$postgres_port" "$metrics_port"; do
    if [[ ! "$port" =~ ^[0-9]+$ ]] || ((port < 1024 || port > 65535)); then
      die "qualification ports must be integers in 1024..65535"
    fi
  done
  [[ "$app_port" != "$postgres_port" && "$app_port" != "$metrics_port" && "$postgres_port" != "$metrics_port" ]] ||
    die "qualification ports must be distinct"
  if [[ "$profile" == pagerduty ]] && [[ -n $(git -C "$root" status --porcelain --untracked-files=normal) ]]; then
    die "pagerduty qualification requires a clean worktree so build provenance matches the tested source"
  fi
  if [[ "$profile" == pagerduty ]] && [[ ! -x "$root/web/node_modules/.bin/playwright" ]]; then
    die "PagerDuty qualification requires installed web dependencies; run make frontend-install"
  fi
  if [[ "$profile" == pagerduty && ${JANUSLY_QUALIFICATION_SNAPSHOT:-0} == 1 ]]; then
    [[ -n ${JANUSLY_QUALIFICATION_SOURCE_ROOT:-} && "$root" != "$JANUSLY_QUALIFICATION_SOURCE_ROOT" ]] ||
      die "invalid PagerDuty qualification source snapshot"
    [[ "$qualification_commit" == "${JANUSLY_QUALIFICATION_SOURCE_COMMIT:-}" &&
       "$qualification_tree" == "${JANUSLY_QUALIFICATION_SOURCE_TREE:-}" ]] ||
      die "PagerDuty source snapshot does not match the frozen candidate"
    if git -C "$root" symbolic-ref --quiet HEAD >/dev/null; then
      die "PagerDuty qualification source snapshot must use a detached HEAD"
    fi
  fi
  if ((uses_supabase)); then
    [[ -x "$supabase_bin" ]] ||
      die "Supabase CLI is missing; run make frontend-install"
  fi
}

pagerduty_candidate_unchanged() {
  [[ $(git -C "$root" rev-parse HEAD) == "$qualification_commit" ]] &&
    [[ $(git -C "$root" rev-parse 'HEAD^{tree}') == "$qualification_tree" ]] &&
    [[ -z $(git -C "$root" status --porcelain --untracked-files=normal) ]]
}

remove_qualification_snapshot() {
  if [[ -z "$qualification_snapshot" ]]; then return 0; fi
  git -C "$root" worktree remove --force "$qualification_snapshot" >/dev/null
  qualification_snapshot=
}

# The live checkout is not an immutable build context even when it is clean at
# both ends of a run. Execute the flagship qualification from a detached
# worktree at the frozen commit so Docker, Playwright, and Go all consume the
# same source. Only the ignored dependency directory is shared; no source file
# comes from the mutable checkout.
run_pagerduty_snapshot() {
  qualification_snapshot=$(mktemp -d "${TMPDIR:-/tmp}/janusly-pagerduty-source.XXXXXX")
  rmdir "$qualification_snapshot"
  trap remove_qualification_snapshot EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  git -C "$root" worktree add --quiet --detach "$qualification_snapshot" "$qualification_commit"
  ln -s "$root/web/node_modules" "$qualification_snapshot/web/node_modules"

  local exit_status
  set +e
  JANUSLY_QUALIFICATION_SNAPSHOT=1 \
  JANUSLY_QUALIFICATION_SOURCE_ROOT="$root" \
  JANUSLY_QUALIFICATION_SOURCE_COMMIT="$qualification_commit" \
  JANUSLY_QUALIFICATION_SOURCE_TREE="$qualification_tree" \
  JANUSLY_EVIDENCE_DIR="$evidence_root" \
    "$qualification_snapshot/scripts/qualification-local.sh" pagerduty
  exit_status=$?
  set -e

  if ! remove_qualification_snapshot; then
    printf 'qualification: failed to remove detached PagerDuty source snapshot\n' >&2
    exit_status=1
  fi
  trap - EXIT INT TERM
  return "$exit_status"
}

supabase() {
  mkdir -p "$supabase_home"
  HOME="$supabase_home" \
  SUPABASE_TELEMETRY_DISABLED=1 \
  DO_NOT_TRACK=1 \
    "$supabase_bin" --workdir "$root" "$@"
}

compose() {
  COMPOSE_PROJECT_NAME="$project" \
  JANUSLY_HOST_PORT="$app_port" \
  JANUSLY_POSTGRES_HOST_PORT="$postgres_port" \
  JANUSLY_INTERNAL_HOST_PORT="$metrics_port" \
  JANUSLY_INTERNAL_HOST=0.0.0.0 \
  JANUSLY_ENV="$janusly_env" \
  JANUSLY_BUILD_COMMIT="$qualification_commit" \
  JANUSLY_BUILD_TREE="$qualification_tree" \
  JANUSLY_BUILD_ID="${qualification_commit:0:7}" \
  JANUSLY_RESUME_TOKEN_SECRET=qualification-resume-token-secret-not-for-production \
  JANUSLY_CREDENTIAL_MASTER_KEY="$credential_master_key" \
  JANUSLY_WEB_BASE_URL="$origin" \
  JANUSLY_BROWSER_CONNECT_ORIGINS="$browser_connect_origins" \
  API_ALLOWED_ORIGINS="http://127.0.0.1:${app_port},http://localhost:${app_port}" \
  ALLOW_DEV_AUTH_HEADERS="$allow_dev_auth_headers" \
  SUPABASE_URL="$runtime_supabase_url" \
  SUPABASE_SERVICE_ROLE_KEY="$runtime_supabase_service_role_key" \
  VITE_SUPABASE_URL="$build_supabase_url" \
  VITE_SUPABASE_ANON_KEY="$build_supabase_anon_key" \
  ANTHROPIC_API_KEY='' \
  OTEL_EXPORTER="$otel_exporter" \
    docker compose -f "$root/docker-compose.yml" -p "$project" "$@"
}

redact() {
  sed -E \
    -e 's/(eyJ[A-Za-z0-9._-]{20,})/[REDACTED_JWT]/g' \
    -e 's/(sb_(publishable|secret)_[A-Za-z0-9_-]+)/[REDACTED_SUPABASE_KEY]/g' \
    -e 's/(sk-ant-[A-Za-z0-9_-]+)/[REDACTED_ANTHROPIC_KEY]/g'
}

capture_diagnostics() {
  local failed=0
  mkdir -p "$evidence_root/logs"
  chmod 700 "$evidence_root" "$evidence_root/logs" || true
  if ! compose ps --format json >"$evidence_root/logs/compose-ps.json" 2>/dev/null; then
    failed=1
  fi
  if ! { compose logs --no-color --timestamps janusly postgres 2>&1 | redact >"$evidence_root/logs/compose.log"; }; then
    failed=1
  fi
  return "$failed"
}

write_summary() {
  local finished_at checksum_tmp
  finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  mkdir -p "$evidence_root"
  jq -n \
    --arg status "$status" \
    --arg profile "$profile" \
    --arg commit "$qualification_commit" \
    --arg tree "$qualification_tree" \
    --argjson sourceIntegrityVerified "$source_integrity" \
    --arg finishedAt "$finished_at" \
    --arg appOrigin "$origin" \
    --arg supabaseVersion "$(
      if ((uses_supabase)); then
        HOME="$supabase_home" SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 "$supabase_bin" --version 2>/dev/null || printf unknown
      else
        printf not-used
      fi
    )" \
    '{status:$status,profile:$profile,git:{commit:$commit,tree:$tree},sourceIntegrityVerified:$sourceIntegrityVerified,finishedAt:$finishedAt,appOrigin:$appOrigin,supabaseVersion:$supabaseVersion,providerCalls:0,providerCostUsd:0}' \
    >"$evidence_root/summary.json"
  checksum_tmp=$(mktemp "${TMPDIR:-/tmp}/janusly-qualification-sums.XXXXXX")
  if ! (
    cd "$evidence_root"
    find . -type f ! -name SHA256SUMS -print0 |
      sort -z |
      xargs -0 shasum -a 256
  ) >"$checksum_tmp"; then
    rm -f "$checksum_tmp"
    return 1
  fi
  mv "$checksum_tmp" "$evidence_root/SHA256SUMS"
}

cleanup() {
  local exit_status=$?
  trap - EXIT INT TERM
  if [[ "$profile" == pagerduty ]] && ! pagerduty_candidate_unchanged; then
    source_integrity=false
    exit_status=1
    printf 'qualification: PagerDuty candidate source changed while qualification was running\n' >&2
  fi
  if ((started)); then
    if ! capture_diagnostics; then
      exit_status=1
      printf 'qualification: failed to capture final diagnostics\n' >&2
    fi
	fi
	if [[ ${JANUSLY_QUALIFICATION_KEEP_STACK:-0} != 1 ]]; then
		if ((owns_app_project)); then
			compose down --volumes --remove-orphans >/dev/null 2>&1 || true
		fi
		if ((uses_supabase)); then
      supabase stop --project-id "$auth_project" --no-backup >/dev/null 2>&1 || true
    fi
  fi
  if ((exit_status == 0)); then status=passed; fi
  if ! write_summary; then
    exit_status=1
    status=failed
    printf 'qualification: failed to write complete evidence summary\n' >&2
    # Best effort: replace any already-written passing summary with a failed
    # one and retry its checksum manifest exactly once.
    write_summary || true
  fi
  exit "$exit_status"
}

project_has_resources() {
	[[ -n $(docker ps -aq --filter "label=com.docker.compose.project=$project") ]] ||
		[[ -n $(docker volume ls -q --filter "label=com.docker.compose.project=$project") ]] ||
		[[ -n $(docker network ls -q --filter "label=com.docker.compose.project=$project") ]]
}

reset_stacks() {
	[[ ${CONFIRM:-} == reset ]] || die "destructive profiles require CONFIRM=reset"
	command -v docker >/dev/null 2>&1 || die "docker is required"
	project_has_resources && die "refusing pre-existing resources for project $project"
	# From this point any labeled application resource was created by this
	# invocation, so cleanup may remove it even if startup fails midway.
	owns_app_project=1
	if ((uses_supabase)); then
    supabase stop --project-id "$auth_project" --no-backup >/dev/null 2>&1 || true
  fi
}

start_supabase() {
  supabase start --exclude realtime,storage-api,imgproxy,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor >/dev/null
  local auth_status
  auth_status=$(supabase status -o json)
  configure_supabase_status "$auth_status"
}

configure_supabase_status() {
  local auth_status=$1
  build_supabase_anon_key=$(jq -er '.ANON_KEY // .PUBLISHABLE_KEY // .anon_key // .publishable_key' <<<"$auth_status")
  runtime_supabase_service_role_key=$(jq -er '.SERVICE_ROLE_KEY // .SECRET_KEY // .service_role_key // .secret_key' <<<"$auth_status")
  export VITE_SUPABASE_ANON_KEY="$build_supabase_anon_key"
  export SUPABASE_SERVICE_ROLE_KEY="$runtime_supabase_service_role_key"
}

wait_for_app() {
  local _
  for _ in $(seq 1 120); do
    if curl --fail --silent "$origin/healthz" >/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

start_app() {
  compose up -d --wait postgres
  compose build janusly
  compose run --rm janusly migrate
  compose up -d janusly
  wait_for_app
}

run_spec() {
  local spec=$1
  shift
  mkdir -p "$evidence_root/screenshots"
  (
    cd "$root/web"
    env \
      PLAYWRIGHT_SKIP_WEB_SERVER=1 \
      JANUSLY_E2E_RUNTIME_BASE_URL="$origin" \
      E2E_API_URL="$origin" \
      JANUSLY_EVIDENCE_DIR="$evidence_root/screenshots" \
      "$@" \
      ./node_modules/.bin/playwright test "$spec" --project=chromium --workers=1
  )
}

run_profile() {
  case "$1" in
    clean)
      run_spec e2e/local-clean-install.spec.ts JANUSLY_LOCAL_CLEAN_INSTALL_E2E=1
      ;;
    identity)
      run_spec e2e/local-identity-stack.spec.ts JANUSLY_LOCAL_IDENTITY_E2E=1
      compose stop janusly
      supabase stop --project-id "$auth_project" >/dev/null
      start_supabase
      compose up -d janusly
      wait_for_app
      run_spec e2e/local-identity-stack.spec.ts \
        JANUSLY_LOCAL_IDENTITY_E2E=1 \
        JANUSLY_LOCAL_IDENTITY_PERSISTENCE_ONLY=1
      ;;
    security)
      run_spec e2e/local-security.spec.ts JANUSLY_LOCAL_SECURITY_E2E=1 JANUSLY_SECURITY_API_URL="$origin"
      ;;
    tenant)
      run_spec e2e/local-tenant-isolation.spec.ts JANUSLY_LOCAL_TENANT_ISOLATION_E2E=1 JANUSLY_TENANT_API_URL="$origin"
      ;;
    recovery)
      run_spec e2e/local-backup-restore.spec.ts \
        JANUSLY_LOCAL_BACKUP_RESTORE_E2E=1 \
        JANUSLY_BACKUP_RESTORE_PHASE=seed \
        JANUSLY_BACKUP_RESTORE_API_URL="$origin"
      local backup_dir="$evidence_root/database-backup"
      COMPOSE_PROJECT_NAME="$project" \
      JANUSLY_RECOVERY_COMPOSE_FILE="$root/docker-compose.yml" \
      JANUSLY_CREDENTIAL_MASTER_KEY="$credential_master_key" \
        "$root/scripts/postgres-local-recovery.sh" backup "$backup_dir" \
        >"$evidence_root/backup-result.json"
      compose down --volumes --remove-orphans
      compose up -d --wait postgres
      if COMPOSE_PROJECT_NAME="$project" \
        JANUSLY_RECOVERY_COMPOSE_FILE="$root/docker-compose.yml" \
        JANUSLY_CREDENTIAL_MASTER_KEY=qualification-wrong-key \
        CONFIRM=restore \
          "$root/scripts/postgres-local-recovery.sh" restore "$backup_dir" \
          >"$evidence_root/wrong-key-refusal.log" 2>&1; then
        die "restore accepted a mismatched credential key"
      fi
      grep -F "credential master key does not match the backup" \
        "$evidence_root/wrong-key-refusal.log" >/dev/null ||
        die "restore failed for an unexpected reason with the wrong key"
      local tampered_dir="$evidence_root/tampered-backup"
      cp -R "$backup_dir" "$tampered_dir"
      printf 'tampered\n' >>"$tampered_dir/database.dump"
      if COMPOSE_PROJECT_NAME="$project" \
        JANUSLY_RECOVERY_COMPOSE_FILE="$root/docker-compose.yml" \
        JANUSLY_CREDENTIAL_MASTER_KEY="$credential_master_key" \
        CONFIRM=restore \
          "$root/scripts/postgres-local-recovery.sh" restore "$tampered_dir" \
          >"$evidence_root/checksum-refusal.log" 2>&1; then
        die "restore accepted a tampered dump"
      fi
      grep -F "backup dump checksum mismatch" \
        "$evidence_root/checksum-refusal.log" >/dev/null ||
        die "restore failed for an unexpected reason with the tampered dump"
      COMPOSE_PROJECT_NAME="$project" \
      JANUSLY_RECOVERY_COMPOSE_FILE="$root/docker-compose.yml" \
      JANUSLY_CREDENTIAL_MASTER_KEY="$credential_master_key" \
      CONFIRM=restore \
        "$root/scripts/postgres-local-recovery.sh" restore "$backup_dir" \
        >"$evidence_root/restore-result.json"
      if COMPOSE_PROJECT_NAME="$project" \
        JANUSLY_RECOVERY_COMPOSE_FILE="$root/docker-compose.yml" \
        JANUSLY_CREDENTIAL_MASTER_KEY="$credential_master_key" \
        CONFIRM=restore \
          "$root/scripts/postgres-local-recovery.sh" restore "$backup_dir" \
          >"$evidence_root/nonempty-refusal.log" 2>&1; then
        die "restore accepted a non-empty target"
      fi
      grep -F "restore target is not empty" \
        "$evidence_root/nonempty-refusal.log" >/dev/null ||
        die "restore failed for an unexpected reason on a non-empty target"
      compose run --rm janusly migrate
      compose up -d janusly
      wait_for_app
      run_spec e2e/local-backup-restore.spec.ts \
        JANUSLY_LOCAL_BACKUP_RESTORE_E2E=1 \
        JANUSLY_BACKUP_RESTORE_PHASE=restored \
        JANUSLY_BACKUP_RESTORE_API_URL="$origin"
      ;;
    pagerduty)
      run_spec e2e/pagerduty-prompt-flow.spec.ts JANUSLY_LOCAL_STACK_E2E=1
      compose stop janusly
      mkdir -p "$evidence_root/tests"
      (
        cd "$root"
        env \
          ANTHROPIC_API_KEY='' \
          JANUSLY_DATABASE_URL="postgres://janusly:janusly-local@127.0.0.1:${postgres_port}/janusly?sslmode=disable" \
          go test -race -tags=integration -p 1 -count=1 \
            ./internal/contract ./internal/domain ./internal/engine ./internal/httpapi ./internal/mcpserver ./internal/secretstore ./internal/store \
            -run '^Test(SemanticOutcomeInterception|GovernedSemanticRecoveryLifecycle|AuthoringCapabilityCatalogIsExactAndSecretFree|AuthoringContractFirstVersionedAliases|ConcurrentWorkflowSavesSerializeWithoutLostVersions|CycleDetectionHandlesDeepGraphsIteratively|DecodeBodyErrorsAreNeverDiscarded|DecodeCompileWorkflowBriefRequestPreservesOmissionAndRejectsNull|DecodeWorkflowProposalRequestPreservesOmissionAndRejectsNull|EveryContractClientOperationMatchesAllSources|EveryHTTPInternalErrorIsRedacted|EveryV1RouteIsDeclaredInTheManifest|EveryWebPathResolvesToARegisteredRoute|ExternalTriggerInternalErrorsAreRedacted|GovernedMutationManifestsRejectUnknownProperties|GovernedRecoveryInternalErrorsAreRedacted|InsertTriggerEventConcurrentDeterministicIdentityConverges|ParsePersistedWorkflowSloReusesTheClosedWriteContract|ParseRejectsInvalidAndExcessiveInputSchemas|ParseSemanticRecoveryCandidateAllowsOnlyBoundedManualFollowUp|ParseSemanticRecoveryValidationRequiresExactEnvelope|ReachableNodesWithoutPreservesOriginalRootBoundary|RecoveryCandidatesRequestPreservesWireIntent|RecoveryCaseDetailProjectsOnlyCurrentBoundedApproval|RecoveryCaseDetailRetainsFoundationsAndNewestBoundedEvidence|RecoveryCaseReads|RecoveryContractValidation|RollbackReadinessStartsOnlyAfterFirstSavedVersion|OperatorBriefDoesNotCrossReadPermissionBoundaries|SecretStoreDetailedResolutionClassifiesStoreFailure|SecretStoreRootKeyPosture|SemanticGuardIssuesUseStableEffectOrder|WorkflowDocumentCanonicalizesKnownContractFields|WorkflowDocumentDefaultsMetadataAndRejectsExplicitNull|WorkflowDocumentRejectsNestedNullsAndMalformedUI|WorkflowHealthFailsClosedOnMalformedPersistedSlo|WorkflowHealthTreatsAbsentPersistedSloAsUndeclared|WorkflowParseRejectsRecoveryWireDriftAndNormalizesStrings|WorkflowProposalProviderFreeDoesNotMutateCanvasOrPersistence|WorkflowProposalSkipsProviderForStaleCatalog|WorkflowProposalProviderFreeBuildsExactPagerDutyFlagship|WorkflowReadSurfaces|WorkflowRecoveryWireMatchesStrictSourceContract|WorkflowRollbackAtomicallyRestoresSchedulesAndReliability|WorkflowSaveManifestPreservesAuthorityBoundary|WorkflowSavePersistsCanonicalSnapshotAndCarriesReliability|WorkflowSaveTopLevelContractIsStrict|WorkflowSaveUpstreamCarrierValidation|WorkflowSloMutationRequiresExplicitReplacement|WorkflowSloMutationSharesVersionSerializationLock|GenerateWorkflowLadder|PagerDutySignedV3Flow|PagerDutyConcurrentRateLimitSettlementNeverStartsRun|PagerDutyCrashWindowUsesPersistedWorkflowSnapshot|CompiledPagerDutyFlagshipVerifiesProviderOutcome|MCPResponseAndExpectedErrorsAreGloballyBounded|McpPagerDutyFlagshipIsProviderFreeBoundedAndExactlyBound|McpGovernedSemanticRecoveryRequiresIndependentApproval|McpPermissionDenialsCannotConsumeAuthorizedToolBucket|McpWorkflowSaveUsesCanonicalAtomicEngineOperation)$'
      ) 2>&1 | redact | tee "$evidence_root/tests/pagerduty-provider-free.log"
      ;;
    load)
      local load_evidence="$evidence_root/load"
      JANUSLY_LOAD_ORIGIN="$origin" \
      JANUSLY_LOAD_METRICS_ORIGIN="http://127.0.0.1:${metrics_port}" \
      JANUSLY_LOAD_COMPOSE_PROJECT="$project" \
      JANUSLY_LOAD_COMPOSE_FILE="$root/docker-compose.yml" \
      JANUSLY_LOAD_EVIDENCE_DIR="$load_evidence" \
        "$root/scripts/load-soak-local.sh"
      local expected_runs
      expected_runs=$(jq -er '.expectedRuns | select(. > 0)' "$load_evidence/summary.json")
      run_spec e2e/local-load-soak.spec.ts \
        JANUSLY_LOCAL_LOAD_SOAK_E2E=1 \
        JANUSLY_LOAD_EXPECTED_RUNS="$expected_runs" \
        JANUSLY_LOAD_WORKFLOW_NAME="${JANUSLY_LOAD_WORKFLOW_NAME:-Load soak workflow}" \
        JANUSLY_LOCAL_ORG_ID="${JANUSLY_LOAD_ORG_ID:-default}"
      ;;
  esac
}

if [[ "$profile" == load || "$profile" == pagerduty ]]; then
  uses_supabase=0
  janusly_env=development
  allow_dev_auth_headers=true
  browser_connect_origins=
  runtime_supabase_url=
  runtime_supabase_service_role_key=
  build_supabase_url=
  build_supabase_anon_key=
  otel_exporter=none
fi

validate_configuration
if [[ "$profile" == pagerduty && ${JANUSLY_QUALIFICATION_SNAPSHOT:-0} != 1 ]]; then
  run_pagerduty_snapshot
  exit $?
fi
if [[ "$profile" == selftest ]]; then
  if [[ -n ${JANUSLY_QUALIFICATION_SUPABASE_STATUS_JSON:-} ]]; then
    configure_supabase_status "$JANUSLY_QUALIFICATION_SUPABASE_STATUS_JSON"
  fi
  jq -n \
    --arg project "$project" \
    --arg authProject "$auth_project" \
    --arg origin "$origin" \
    --argjson supabaseConfigured "$([[ -n "$build_supabase_anon_key" && -n "$runtime_supabase_service_role_key" ]] && printf true || printf false)" \
    '{project:$project,authProject:$authProject,origin:$origin,supabaseConfigured:$supabaseConfigured}'
  exit 0
fi

mkdir -p "$evidence_root"
chmod 700 "$evidence_root"
trap cleanup EXIT INT TERM
reset_stacks
if ((uses_supabase)); then
  start_supabase
fi
started=1
start_app

if [[ "$profile" == all ]]; then
  for selected in clean identity security tenant recovery; do run_profile "$selected"; done
else
  run_profile "$profile"
fi
