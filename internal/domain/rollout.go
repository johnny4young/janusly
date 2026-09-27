package domain

// WorkflowRolloutStatuses is the rollout lifecycle: active until it is
// promoted, rolled back, or cancelled.
var WorkflowRolloutStatuses = []string{"active", "promoted", "rolled_back", "cancelled"}
