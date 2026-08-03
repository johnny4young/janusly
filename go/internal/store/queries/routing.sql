-- Tenant-scoped reinforcement counters for deterministic router decisions.

-- name: ListRoutingStats :many
SELECT node_id, pulls, mean_reward
FROM routing_stats
WHERE org_id = $1
ORDER BY node_id;

-- Atomic across replicas: each terminal/retry CAS that wins records exactly
-- one reward in the same transaction as the node transition.
-- name: RecordRoutingOutcome :exec
INSERT INTO routing_stats (
  id, org_id, node_id, pulls, value, mean_reward,
  success_count, failure_count, updated_at
)
VALUES (
  sqlc.arg(id), sqlc.arg(org_id), sqlc.arg(node_id), 1,
  sqlc.arg(reward), sqlc.arg(reward),
  sqlc.arg(success_count), sqlc.arg(failure_count), sqlc.arg(updated_at)
)
ON CONFLICT (org_id, node_id) DO UPDATE SET
  pulls = routing_stats.pulls + 1,
  value = routing_stats.value + EXCLUDED.value,
  mean_reward = (routing_stats.value + EXCLUDED.value) / (routing_stats.pulls + 1),
  success_count = routing_stats.success_count + EXCLUDED.success_count,
  failure_count = routing_stats.failure_count + EXCLUDED.failure_count,
  updated_at = EXCLUDED.updated_at;
