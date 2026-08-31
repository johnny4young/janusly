#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
origin=${JANUSLY_LOAD_ORIGIN:-http://127.0.0.1:7310}
metrics_origin=${JANUSLY_LOAD_METRICS_ORIGIN:-http://127.0.0.1:7464}
compose_project=${JANUSLY_LOAD_COMPOSE_PROJECT:-janusly-qualification-app}
compose_file=${JANUSLY_LOAD_COMPOSE_FILE:-$root/docker-compose.yml}
evidence_dir=${JANUSLY_LOAD_EVIDENCE_DIR:-$root/output/load-soak/$(date -u +%Y%m%dT%H%M%SZ)}
warmup_duration=${JANUSLY_LOAD_WARMUP_DURATION:-2m}
measure_duration=${JANUSLY_LOAD_MEASURE_DURATION:-20m}
settle_seconds=${JANUSLY_LOAD_SETTLE_SECONDS:-360}
sample_interval=${JANUSLY_LOAD_SAMPLE_INTERVAL:-5}
queue_probe_interval_seconds=${JANUSLY_LOAD_QUEUE_PROBE_INTERVAL_SECONDS:-1}
org_id=${JANUSLY_LOAD_ORG_ID:-default}
user_id=${JANUSLY_LOAD_USER_ID:-local-load-soak}
workflow_name=${JANUSLY_LOAD_WORKFLOW_NAME:-Load soak workflow}
smoke_mode=${JANUSLY_LOAD_SMOKE:-0}
monitor_pid=
temporary_dir=

umask 077

die() {
  printf 'load-soak-local: %s\n' "$*" >&2
  exit 2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"
}

compose() {
  docker compose -f "$compose_file" -p "$compose_project" "$@"
}

cleanup() {
  local exit_status=$?
  trap - EXIT INT TERM
  if [[ -n "$monitor_pid" ]] && kill -0 "$monitor_pid" 2>/dev/null; then
    kill "$monitor_pid" 2>/dev/null || true
    wait "$monitor_pid" 2>/dev/null || true
  fi
  if [[ -n "$temporary_dir" && -d "$temporary_dir" ]]; then
    rm -rf -- "$temporary_dir"
  fi
  exit "$exit_status"
}

validate_configuration() {
  for command in curl docker go jq; do require_command "$command"; done
  [[ "$compose_project" =~ ^janusly-qualification-[a-z0-9-]+$ ]] ||
    die "Compose project must start with janusly-qualification-"
  [[ -f "$compose_file" && ! -L "$compose_file" ]] || die "Compose file must be a regular non-symlink"
  [[ "$sample_interval" =~ ^[1-9][0-9]*$ ]] || die "sample interval must be a positive integer"
  [[ "$queue_probe_interval_seconds" =~ ^[1-9][0-9]?$ ]] &&
    ((queue_probe_interval_seconds <= 60)) ||
    die "queue probe interval must be an integer in 1..60 seconds"
  [[ "$settle_seconds" =~ ^[0-9]+$ ]] || die "settle seconds must be a non-negative integer"
  [[ "$smoke_mode" == 0 || "$smoke_mode" == 1 ]] || die "JANUSLY_LOAD_SMOKE must be 0 or 1"
  [[ "$origin" =~ ^http://(127\.0\.0\.1|localhost|\[::1\]):[0-9]+$ ]] ||
    die "load origin must be an explicit loopback HTTP origin"
  [[ "$metrics_origin" =~ ^http://(127\.0\.0\.1|localhost|\[::1\]):[0-9]+$ ]] ||
    die "metrics origin must be an explicit loopback HTTP origin"
  [[ -n "$org_id" && -n "$user_id" && -n "$workflow_name" ]] ||
    die "organization, user, and workflow name must be non-empty"
  [[ ! -e "$evidence_dir" && ! -L "$evidence_dir" ]] ||
    die "evidence directory already exists: $evidence_dir"
}

metric_value() {
  local body=$1 name=$2
  awk -v metric="$name" '$1 == metric { print $2; exit }' <<<"$body"
}

capture_runtime_metrics() {
  local output=$1 body rss goroutines heap
  body=$(curl --fail --silent --show-error --max-time 10 "$metrics_origin/metrics")
  rss=$(metric_value "$body" process_resident_memory_bytes)
  goroutines=$(metric_value "$body" go_goroutines)
  heap=$(metric_value "$body" go_memstats_heap_alloc_bytes)
  [[ "$rss" =~ ^[0-9.eE+-]+$ && "$goroutines" =~ ^[0-9.eE+-]+$ && "$heap" =~ ^[0-9.eE+-]+$ ]] ||
    die "required runtime metrics are missing"
  jq -n \
    --arg capturedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson rssBytes "$rss" \
    --argjson goroutines "$goroutines" \
    --argjson heapBytes "$heap" \
    '{capturedAt:$capturedAt,rssBytes:$rssBytes,goroutines:$goroutines,heapBytes:$heapBytes}' \
    >"$output"
}

postgres_connections() {
  compose exec -T postgres \
    psql -XAt -v ON_ERROR_STOP=1 -U janusly -d janusly \
      -c "SELECT count(*) FROM pg_stat_activity WHERE datname = 'janusly';"
}

capture_postgres_connections() {
  local output=$1 count
  count=$(postgres_connections)
  [[ "$count" =~ ^[0-9]+$ ]] || die "invalid PostgreSQL connection count"
  jq -n --argjson connections "$count" '{connections:$connections}' >"$output"
}

force_gc() {
  curl --fail --silent --show-error --max-time 30 \
    "$metrics_origin/debug/pprof/heap?gc=1" >/dev/null
}

monitor_runtime() {
  local body rss goroutines heap
  while true; do
    if body=$(curl --fail --silent --max-time 10 "$metrics_origin/metrics" 2>/dev/null); then
      rss=$(metric_value "$body" process_resident_memory_bytes)
      goroutines=$(metric_value "$body" go_goroutines)
      heap=$(metric_value "$body" go_memstats_heap_alloc_bytes)
      if [[ "$rss" =~ ^[0-9.eE+-]+$ && "$goroutines" =~ ^[0-9.eE+-]+$ && "$heap" =~ ^[0-9.eE+-]+$ ]]; then
        printf '%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rss" "$goroutines" "$heap" \
          >>"$evidence_dir/runtime-samples.tsv"
      fi
    fi
    sleep "$sample_interval"
  done
}

run_phase() {
  local scenario=$1 vus=$2 duration=$3 label=$4
  local output="$evidence_dir/$label.json"
  "$temporary_dir/loadgen" \
    -base "$origin" \
    -scenario "$scenario" \
    -vus "$vus" \
    -duration "$duration" \
    -org "$org_id" \
    -user "$user_id" \
    -workflow-name "$workflow_name" \
    -queue-probe-interval "${queue_probe_interval_seconds}s" \
    -allow-dev-auth \
    >"$output"
  jq -e '
    .iterations > 0 and .errors == 0 and .errorRate == 0 and
    (.queueObservability as $queue |
      $queue.probes > 0 and
      ($queue.validSnapshots + $queue.unavailableSnapshots == $queue.probes) and
      $queue.minimumAvailability == 0.995 and
      $queue.unavailableConsecutiveLimit == 6 and
      $queue.availability >= $queue.minimumAvailability and
      $queue.maxUnavailableConsecutive <= $queue.unavailableConsecutiveLimit and
      $queue.passed == true)
  ' "$output" >/dev/null || die "$label failed its request or queue-observability budget"
}

queue_snapshot() {
  curl --fail --silent --show-error --max-time 10 \
    -H "x-org-id: $org_id" \
    -H "x-user-id: $user_id" \
    "$origin/system/queue"
}

wait_for_queue_drain() {
  local snapshot
  for _ in $(seq 1 600); do
    snapshot=$(queue_snapshot)
    if jq -e '
      .waiting == 0 and .active == 0 and
      (.maintenance == null or (.maintenance.waiting == 0 and .maintenance.active == 0))
    ' <<<"$snapshot" >/dev/null; then
      printf '%s\n' "$snapshot" >"$evidence_dir/queue-after.json"
      return
    fi
    sleep 1
  done
  printf '%s\n' "$snapshot" >"$evidence_dir/queue-after.json"
  die "queues did not drain within 10 minutes"
}

write_summary() {
  local peak_rss peak_goroutines expected_runs smoke_json=false
  peak_rss=$(awk -F '\t' 'BEGIN { max = 0 } { if (($2 + 0) > max) max = $2 + 0 } END { printf "%.0f", max }' "$evidence_dir/runtime-samples.tsv")
  peak_goroutines=$(awk -F '\t' 'BEGIN { max = 0 } { if (($3 + 0) > max) max = $3 + 0 } END { printf "%.0f", max }' "$evidence_dir/runtime-samples.tsv")
  expected_runs=$(jq -s 'map(.iterations) | add' \
    "$evidence_dir/start-warmup.json" \
    "$evidence_dir/start-measured.json" \
    "$evidence_dir/diamond-warmup.json" \
    "$evidence_dir/diamond-measured.json")
  if [[ "$smoke_mode" == 1 ]]; then smoke_json=true; fi

  jq -n \
    --arg commit "$(git -C "$root" rev-parse HEAD)" \
    --arg tree "$(git -C "$root" rev-parse 'HEAD^{tree}')" \
    --arg warmupDuration "$warmup_duration" \
    --arg measureDuration "$measure_duration" \
    --argjson settleSeconds "$settle_seconds" \
    --argjson queueProbeIntervalSeconds "$queue_probe_interval_seconds" \
    --argjson expectedRuns "$expected_runs" \
    --argjson peakRssBytes "$peak_rss" \
    --argjson peakGoroutines "$peak_goroutines" \
    --argjson smoke "$smoke_json" \
    --slurpfile baselineRuntime "$evidence_dir/runtime-baseline.json" \
    --slurpfile finalRuntime "$evidence_dir/runtime-final.json" \
    --slurpfile baselineDatabase "$evidence_dir/postgres-baseline.json" \
    --slurpfile finalDatabase "$evidence_dir/postgres-final.json" \
    --slurpfile startWarmup "$evidence_dir/start-warmup.json" \
    --slurpfile start "$evidence_dir/start-measured.json" \
    --slurpfile listWarmup "$evidence_dir/list-warmup.json" \
    --slurpfile list "$evidence_dir/list-measured.json" \
    --slurpfile diamondWarmup "$evidence_dir/diamond-warmup.json" \
    --slurpfile diamond "$evidence_dir/diamond-measured.json" \
    --slurpfile queue "$evidence_dir/queue-after.json" \
    '[
      ({phase:"start-warmup"} + $startWarmup[0].queueObservability),
      ({phase:"start-measured"} + $start[0].queueObservability),
      ({phase:"list-warmup"} + $listWarmup[0].queueObservability),
      ({phase:"list-measured"} + $list[0].queueObservability),
      ({phase:"diamond-warmup"} + $diamondWarmup[0].queueObservability),
      ({phase:"diamond-measured"} + $diamond[0].queueObservability)
    ] as $queuePhases |
    {
      git:{commit:$commit,tree:$tree},
      mode:(if $smoke then "smoke" else "qualification" end),
      durations:{
        warmup:$warmupDuration,
        measured:$measureDuration,
        settleSeconds:$settleSeconds,
        queueProbeIntervalSeconds:$queueProbeIntervalSeconds
      },
      expectedRuns:$expectedRuns,
      runtime:{baseline:$baselineRuntime[0],final:$finalRuntime[0],peakRssBytes:$peakRssBytes,peakGoroutines:$peakGoroutines},
      postgres:{baseline:$baselineDatabase[0],final:$finalDatabase[0]},
      scenarios:{start:$start[0],list:$list[0],diamond:$diamond[0]},
      queueObservability:{
        phases:$queuePhases,
        minimumAvailabilityObserved:($queuePhases | map(.availability) | min),
        maxUnavailableConsecutiveObserved:($queuePhases | map(.maxUnavailableConsecutive) | max)
      },
      queue:$queue[0],
      thresholds:{
        start:{p95Ms:1500,p99Ms:5000},
        list:{p95Ms:750,p99Ms:1500},
        diamond:{p95Ms:2000,p99Ms:5000},
        queueSnapshotAvailability:0.995,
        queueUnavailableConsecutive:6,
        peakRssBytes:536870912,
        finalRssGrowthBytes:67108864,
        finalHeapGrowthBytes:33554432,
        finalGoroutineGrowth:2,
        finalConnectionGrowth:2
      },
      budgets:{
        zeroErrors:([
          $startWarmup[0].errors,$start[0].errors,
          $listWarmup[0].errors,$list[0].errors,
          $diamondWarmup[0].errors,$diamond[0].errors
        ] | all(. == 0)),
        queueSnapshots:($queuePhases | all(.passed == true)),
        startLatency:($start[0].p95Ms <= 1500 and $start[0].p99Ms <= 5000),
        listLatency:($list[0].p95Ms <= 750 and $list[0].p99Ms <= 1500),
        diamondLatency:($diamond[0].p95Ms <= 2000 and $diamond[0].p99Ms <= 5000),
        queuesDrained:($queue[0].waiting == 0 and $queue[0].active == 0 and ($queue[0].maintenance == null or ($queue[0].maintenance.waiting == 0 and $queue[0].maintenance.active == 0))),
        peakRss:($peakRssBytes <= 536870912),
        finalRss:($finalRuntime[0].rssBytes <= ($baselineRuntime[0].rssBytes + 67108864)),
        finalHeap:($finalRuntime[0].heapBytes <= ($baselineRuntime[0].heapBytes + 33554432)),
        finalGoroutines:($finalRuntime[0].goroutines <= ($baselineRuntime[0].goroutines + 2)),
        finalConnections:($finalDatabase[0].connections <= ($baselineDatabase[0].connections + 2))
      }
    } |
    .passed = (
      .budgets.zeroErrors and .budgets.queueSnapshots and
      .budgets.startLatency and .budgets.listLatency and
      .budgets.diamondLatency and .budgets.queuesDrained and .budgets.peakRss and
      ($smoke or (
        .budgets.finalRss and .budgets.finalHeap and .budgets.finalGoroutines and
        .budgets.finalConnections
      ))
    )' \
    >"$evidence_dir/summary.json"
  jq -e '.passed == true' "$evidence_dir/summary.json" >/dev/null ||
    die "one or more load/soak budgets failed; inspect $evidence_dir/summary.json"
}

run_selftest() {
  temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/janusly-load-soak-selftest.XXXXXX")
  evidence_dir="$temporary_dir/evidence"
  mkdir -p "$evidence_dir"
  trap cleanup EXIT INT TERM

  jq -n '{
    iterations:1,errors:0,errorRate:0,p95Ms:1,p99Ms:2,
    queueObservability:{
      probes:200,validSnapshots:199,unavailableSnapshots:1,
      availability:0.995,maxUnavailableConsecutive:1,maxActive:3,maxWaiting:7,
      minimumAvailability:0.995,unavailableConsecutiveLimit:6,passed:true
    }
  }' >"$temporary_dir/phase.json"
  for phase in start-warmup start-measured list-warmup list-measured diamond-warmup diamond-measured; do
    cp "$temporary_dir/phase.json" "$evidence_dir/$phase.json"
  done
  printf '{"capturedAt":"2026-01-01T00:00:00Z","rssBytes":100,"goroutines":2,"heapBytes":50}\n' \
    >"$evidence_dir/runtime-baseline.json"
  cp "$evidence_dir/runtime-baseline.json" "$evidence_dir/runtime-final.json"
  printf '{"connections":2}\n' >"$evidence_dir/postgres-baseline.json"
  cp "$evidence_dir/postgres-baseline.json" "$evidence_dir/postgres-final.json"
  printf '{"waiting":0,"active":0,"maintenance":{"waiting":0,"active":0}}\n' \
    >"$evidence_dir/queue-after.json"
  printf 'captured_at\trss_bytes\tgoroutines\theap_bytes\n2026-01-01T00:00:00Z\t100\t2\t50\n' \
    >"$evidence_dir/runtime-samples.tsv"
  smoke_mode=1
  write_summary
  jq -e '
    .passed == true and .budgets.queueSnapshots == true and
    (.queueObservability.phases | length) == 6 and
    .queueObservability.minimumAvailabilityObserved == 0.995 and
    .queueObservability.maxUnavailableConsecutiveObserved == 1
  ' "$evidence_dir/summary.json" >/dev/null
  cat "$evidence_dir/summary.json"
}

if [[ ${JANUSLY_LOAD_SELFTEST:-0} == 1 ]]; then
  run_selftest
  exit 0
fi

validate_configuration
mkdir -p "$evidence_dir"
temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/janusly-load-soak.XXXXXX")
trap cleanup EXIT INT TERM

(
  cd "$root"
  GOCACHE="$temporary_dir/go-cache" go build -trimpath -o "$temporary_dir/loadgen" ./cmd/loadgen
)
force_gc
sleep 2
capture_runtime_metrics "$evidence_dir/runtime-baseline.json"
capture_postgres_connections "$evidence_dir/postgres-baseline.json"
printf 'captured_at\trss_bytes\tgoroutines\theap_bytes\n' >"$evidence_dir/runtime-samples.tsv"
monitor_runtime &
monitor_pid=$!

run_phase start 10 "$warmup_duration" start-warmup
run_phase start 10 "$measure_duration" start-measured
run_phase list 50 "$warmup_duration" list-warmup
run_phase list 50 "$measure_duration" list-measured
run_phase diamond 10 "$warmup_duration" diamond-warmup
run_phase diamond 10 "$measure_duration" diamond-measured

kill "$monitor_pid" 2>/dev/null || true
wait "$monitor_pid" 2>/dev/null || true
monitor_pid=
wait_for_queue_drain
sleep "$settle_seconds"
force_gc
sleep 2
capture_runtime_metrics "$evidence_dir/runtime-final.json"
capture_postgres_connections "$evidence_dir/postgres-final.json"
write_summary
jq . "$evidence_dir/summary.json"
