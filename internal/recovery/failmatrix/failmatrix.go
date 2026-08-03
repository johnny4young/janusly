// The single RECOVERY failure-fixture catalog (project rule, same as the
// AI failcat: one catalog feeds every consuming suite, so a new hostile
// case lands in ALL surfaces by adding one entry here). Each case names a
// recovery surface, builds its hostile request from the seeded
// environment, and pins the exact wire contract (status + error code, or
// a partial-success envelope assertion the consumer interprets).
//
// Deliberately dependency-free (stdlib only) so integration suites and
// the dev seeder can import it without cycles.
package failmatrix

// Env carries the ids the consuming suite seeded before iterating.
type Env struct {
	// OpenDeadLetterID is an open, replayable dead letter.
	OpenDeadLetterID string
	// ClaimedDeadLetterID was already replayed (claim burned).
	ClaimedDeadLetterID string
	// AcknowledgedItemID is a recovery item already past `open`.
	AcknowledgedItemID string
	// ClusterSignature is the REAL normalized signature of the open row.
	ClusterSignature string
	// WorkflowDoc is a schema-valid workflow document for fix payloads.
	WorkflowDoc map[string]any
}

// Case is one hostile request and its pinned contract.
type Case struct {
	// Surface groups cases for reporting (replay, cluster, validate,
	// items, queue).
	Surface string
	// Name is the stable case id (also the subtest name).
	Name string
	// Method + Path + Body build the request. Body nil = no JSON body.
	Method string
	Path   func(env Env) string
	Body   func(env Env) map[string]any
	// WantStatus + WantCode pin the wire contract. WantCode "" skips the
	// code assertion (partial-success 200 envelopes assert WantFailed).
	WantStatus int
	WantCode   string
	// WantFailed asserts the partial-success envelope's failed count.
	WantFailed int
}

func idsOf(count int) []any {
	out := make([]any, count)
	for i := range out {
		out[i] = "x"
	}
	return out
}

// Catalog returns every recovery failure case.
func Catalog() []Case {
	staticPath := func(path string) func(Env) string {
		return func(Env) string { return path }
	}
	return []Case{
		// ── replay: the claim boundary ─────────────────────────────────
		{Surface: "replay", Name: "missing_dead_letter", Method: "POST", Path: staticPath("/dlq/replay"),
			Body:       func(Env) map[string]any { return map[string]any{"deadLetterId": "missing"} },
			WantStatus: 404, WantCode: "dlq_not_found"},
		{Surface: "replay", Name: "claim_already_burned", Method: "POST", Path: staticPath("/dlq/replay"),
			Body: func(env Env) map[string]any {
				return map[string]any{"deadLetterId": env.ClaimedDeadLetterID}
			},
			WantStatus: 409, WantCode: "dlq_replay_conflict"},
		{Surface: "replay", Name: "playbook_half_claim", Method: "POST", Path: staticPath("/dlq/replay"),
			Body: func(env Env) map[string]any {
				return map[string]any{"deadLetterId": env.OpenDeadLetterID, "recoveryPlaybookId": "p1"}
			},
			WantStatus: 400, WantCode: "recovery_playbook_invalid_body"},
		{Surface: "replay", Name: "playbook_unverifiable", Method: "POST", Path: staticPath("/dlq/replay"),
			Body: func(env Env) map[string]any {
				return map[string]any{
					"deadLetterId":       env.OpenDeadLetterID,
					"recoveryPlaybookId": "ghost", "recoveryValidationRunId": "ghost",
				}
			},
			WantStatus: 422, WantCode: "recovery_playbook_outcome_invalid"},
		{Surface: "replay", Name: "exact_identity_foreign", Method: "POST", Path: staticPath("/dlq/replay"),
			Body: func(Env) map[string]any {
				return map[string]any{"runId": "ghost-run", "nodeId": "ghost-node"}
			},
			WantStatus: 403, WantCode: "dlq_forbidden"},
		{Surface: "replay", Name: "fields_required", Method: "POST", Path: staticPath("/dlq/replay"),
			Body:       func(Env) map[string]any { return map[string]any{} },
			WantStatus: 400, WantCode: "dlq_fields_required"},

		// ── cluster-apply: the stale-list defenses ─────────────────────
		{Surface: "cluster", Name: "missing_signature", Method: "POST", Path: staticPath("/dlq/cluster-apply"),
			Body: func(env Env) map[string]any {
				return map[string]any{"deadLetterIds": []any{env.OpenDeadLetterID}}
			},
			WantStatus: 400, WantCode: "dlq_field_required"},
		{Surface: "cluster", Name: "ids_required", Method: "POST", Path: staticPath("/dlq/cluster-apply"),
			Body: func(env Env) map[string]any {
				return map[string]any{"clusterSignature": env.ClusterSignature}
			},
			WantStatus: 400, WantCode: "dlq_ids_required"},
		{Surface: "cluster", Name: "ids_over_cap", Method: "POST", Path: staticPath("/dlq/cluster-apply"),
			Body: func(env Env) map[string]any {
				return map[string]any{"clusterSignature": env.ClusterSignature, "deadLetterIds": idsOf(101)}
			},
			WantStatus: 400, WantCode: "dlq_ids_cap_exceeded"},
		{Surface: "cluster", Name: "ids_empty_entry", Method: "POST", Path: staticPath("/dlq/cluster-apply"),
			Body: func(env Env) map[string]any {
				return map[string]any{"clusterSignature": env.ClusterSignature, "deadLetterIds": []any{""}}
			},
			WantStatus: 400, WantCode: "dlq_ids_invalid_entries"},
		{Surface: "cluster", Name: "signature_mismatch_partial", Method: "POST", Path: staticPath("/dlq/cluster-apply"),
			Body: func(env Env) map[string]any {
				return map[string]any{"clusterSignature": "zz-never-matches", "deadLetterIds": []any{env.OpenDeadLetterID}}
			},
			WantStatus: 200, WantFailed: 1},
		{Surface: "cluster", Name: "fix_schema_invalid", Method: "POST", Path: staticPath("/dlq/cluster-apply"),
			Body: func(env Env) map[string]any {
				return map[string]any{
					"clusterSignature":  env.ClusterSignature,
					"deadLetterIds":     []any{env.OpenDeadLetterID},
					"suggestedWorkflow": map[string]any{"nodes": "nope"},
				}
			},
			WantStatus: 400, WantCode: "dlq_workflow_schema_invalid"},
		{Surface: "cluster", Name: "playbook_without_representative", Method: "POST", Path: staticPath("/dlq/cluster-apply"),
			Body: func(env Env) map[string]any {
				return map[string]any{
					"clusterSignature":   env.ClusterSignature,
					"deadLetterIds":      []any{env.OpenDeadLetterID},
					"recoveryPlaybookId": "ghost", "recoveryValidationRunId": "ghost",
				}
			},
			WantStatus: 422, WantCode: "recovery_playbook_outcome_invalid"},

		// ── validate-fix: the sandbox gate ─────────────────────────────
		{Surface: "validate", Name: "missing_dead_letter", Method: "POST", Path: staticPath("/dlq/validate-fix"),
			Body: func(env Env) map[string]any {
				return map[string]any{"deadLetterId": "missing", "suggestedWorkflow": env.WorkflowDoc}
			},
			WantStatus: 404, WantCode: "dlq_not_found"},
		{Surface: "validate", Name: "workflow_required", Method: "POST", Path: staticPath("/dlq/validate-fix"),
			Body: func(env Env) map[string]any {
				return map[string]any{"deadLetterId": env.OpenDeadLetterID}
			},
			WantStatus: 400, WantCode: "dlq_field_required"},
		{Surface: "validate", Name: "effect_mode_unknown", Method: "POST", Path: staticPath("/dlq/validate-fix"),
			Body: func(env Env) map[string]any {
				return map[string]any{
					"deadLetterId": env.OpenDeadLetterID, "suggestedWorkflow": env.WorkflowDoc,
					"validationEffectMode": "live_fire",
				}
			},
			WantStatus: 400, WantCode: "recovery_validation_effect_mode_invalid"},
		{Surface: "validate", Name: "provider_simulation_unavailable", Method: "POST", Path: staticPath("/dlq/validate-fix"),
			Body: func(env Env) map[string]any {
				return map[string]any{
					"deadLetterId": env.OpenDeadLetterID, "suggestedWorkflow": env.WorkflowDoc,
					"validationEffectMode": "provider_simulation",
				}
			},
			WantStatus: 409, WantCode: "recovery_provider_simulation_unavailable"},
		{Surface: "validate", Name: "workflow_schema_broken", Method: "POST", Path: staticPath("/dlq/validate-fix"),
			Body: func(env Env) map[string]any {
				return map[string]any{
					"deadLetterId":      env.OpenDeadLetterID,
					"suggestedWorkflow": map[string]any{"nodes": []any{}, "edges": "nope"},
				}
			},
			WantStatus: 400, WantCode: "dlq_workflow_schema_invalid"},

		// ── items: the CAS ladder + honest reasons ─────────────────────
		{Surface: "items", Name: "missing_item", Method: "POST",
			Path:       func(Env) string { return "/recovery/items/ghost/acknowledge" },
			Body:       func(Env) map[string]any { return map[string]any{} },
			WantStatus: 404, WantCode: "recovery_item_not_found"},
		{Surface: "items", Name: "unknown_action", Method: "POST",
			Path:       func(env Env) string { return "/recovery/items/" + env.AcknowledgedItemID + "/paint" },
			Body:       func(Env) map[string]any { return map[string]any{} },
			WantStatus: 404, WantCode: "recovery_item_not_found"},
		{Surface: "items", Name: "cas_lost_double_acknowledge", Method: "POST",
			Path:       func(env Env) string { return "/recovery/items/" + env.AcknowledgedItemID + "/acknowledge" },
			Body:       func(Env) map[string]any { return map[string]any{} },
			WantStatus: 409, WantCode: "recovery_item_conflict"},
		{Surface: "items", Name: "sandbox_reason_forbidden", Method: "POST",
			Path: func(env Env) string { return "/recovery/items/" + env.AcknowledgedItemID + "/resolve" },
			Body: func(Env) map[string]any {
				return map[string]any{"resolutionReason": "sandbox_replay_succeeded"}
			},
			WantStatus: 400, WantCode: "recovery_item_invalid_body"},
		{Surface: "items", Name: "invalid_severity", Method: "POST",
			Path: func(env Env) string { return "/recovery/items/" + env.AcknowledgedItemID + "/acknowledge" },
			Body: func(Env) map[string]any {
				return map[string]any{"severity": "p9"}
			},
			WantStatus: 400, WantCode: "recovery_item_invalid_body"},
		{Surface: "items", Name: "assign_requires_owner", Method: "POST",
			Path:       func(env Env) string { return "/recovery/items/" + env.AcknowledgedItemID + "/assign" },
			Body:       func(Env) map[string]any { return map[string]any{} },
			WantStatus: 400, WantCode: "recovery_item_invalid_body"},
		{Surface: "items", Name: "handoff_unknown_destination", Method: "POST",
			Path: func(env Env) string { return "/recovery/items/" + env.AcknowledgedItemID + "/handoff" },
			Body: func(Env) map[string]any {
				return map[string]any{"destination": "paloma"}
			},
			WantStatus: 400, WantCode: "recovery_item_invalid_body"},

		// ── queue: the read-model refuses out-of-enum filters ──────────
		{Surface: "queue", Name: "invalid_status", Method: "GET",
			Path:       staticPath("/dlq/queue?status=nope"),
			WantStatus: 400, WantCode: "dlq_invalid_status"},
		{Surface: "queue", Name: "invalid_severity", Method: "GET",
			Path:       staticPath("/dlq/queue?severity=p9"),
			WantStatus: 400, WantCode: "dlq_invalid_severity"},
		{Surface: "queue", Name: "invalid_sort", Method: "GET",
			Path:       staticPath("/dlq/queue?sort=zigzag"),
			WantStatus: 400, WantCode: "dlq_invalid_sort"},
	}
}
