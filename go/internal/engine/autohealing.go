// Supervised auto-healing (reference apps/api/src/auto-healing-*.ts,
// pilot-bounded). A periodic sweep walks orgs with recent open DLQ rows,
// and for each org that OPTED IN (env master gate JANUSLY_AUTO_HEALING_ENABLED
// AND org config autoHealing.enabled — no env fallback per tenant, by
// design) it groups open dead letters by normalized signature and, for
// clusters with frequency >= 2:
//
//	loop-breaker → idempotency → diagnose row → DETERMINISTIC patch
//	proposal → sandbox validation replay → pending operator decision.
//
// Pilot posture: the proposal is the $0 deterministic envelope (retry +
// timeout hardening on the failing node) — an LLM inside a cron is a cost
// decision the pilot defers; the aipatch surface stays the interactive
// LLM door. The watcher half promotes `validating` rows whose sandbox
// replay reached a terminal status: succeeded → `validated` (pending the
// operator's decision — auto-apply stays off in the pilot), failed →
// `validation_failed` + audit. Apply happens in the decision route via
// the fix-snapshot redrive. Never throws; per-candidate failures skip.
package engine

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/auth"
	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/orgconfig"
	"github.com/johnny4young/janusly/go/internal/signature"
	"github.com/johnny4young/janusly/go/internal/store"
)

const autoHealingWindowDays = 7

// AutoHealingScanResult reports one sweep for observability + tests.
type AutoHealingScanResult struct {
	OrgsScanned int
	Proposed    int
	Promoted    int
	Rejected    int
}

// SweepAutoHealing runs one scan + watcher pass across every opted-in org.
func (e *Engine) SweepAutoHealing(ctx context.Context) AutoHealingScanResult {
	result := AutoHealingScanResult{}
	if os.Getenv("JANUSLY_AUTO_HEALING_ENABLED") != "true" {
		return result
	}
	q := store.New(e.pool)
	since := time.Now().AddDate(0, 0, -autoHealingWindowDays)
	orgs, err := q.ListHealingCandidateOrgs(ctx, &since)
	if err != nil {
		return result
	}
	for _, orgID := range orgs {
		if !orgconfig.LoadBool(ctx, e.pool, orgID, "autoHealing.enabled") {
			continue
		}
		result.OrgsScanned++
		result.Proposed += e.scanOrgForHealing(ctx, orgID, since)
	}
	promoted, rejected := e.promoteValidatedHealingRuns(ctx)
	result.Promoted, result.Rejected = promoted, rejected
	return result
}

// ScanOrgForHealing is the on-demand per-org entry (the admin scan route).
func (e *Engine) ScanOrgForHealing(ctx context.Context, orgID string) int {
	if os.Getenv("JANUSLY_AUTO_HEALING_ENABLED") != "true" ||
		!orgconfig.LoadBool(ctx, e.pool, orgID, "autoHealing.enabled") {
		return 0
	}
	since := time.Now().AddDate(0, 0, -autoHealingWindowDays)
	proposed := e.scanOrgForHealing(ctx, orgID, since)
	e.promoteValidatedHealingRuns(ctx)
	return proposed
}

func (e *Engine) scanOrgForHealing(ctx context.Context, orgID string, since time.Time) int {
	q := store.New(e.pool)
	rows, err := q.ListOpenDeadLettersForHealing(ctx, store.ListOpenDeadLettersForHealingParams{
		OrgID: orgID, CreatedAt: &since,
	})
	if err != nil {
		return 0
	}
	// Group by normalized signature; frequency >= 2 marks a cluster worth
	// healing (a one-off is the operator's manual call).
	bySignature := map[string][]store.ListOpenDeadLettersForHealingRow{}
	for _, row := range rows {
		normalized := signature.NormalizeJSON(row.ErrorJson, signature.Context{})
		bySignature[normalized.Signature] = append(bySignature[normalized.Signature], row)
	}
	maxAttempts := int(orgconfig.LoadNumber(ctx, e.pool, orgID, "autoHealing.maxAttemptsPerSignature"))
	if maxAttempts < 1 || maxAttempts > 10 {
		maxAttempts = 3
	}
	loopWindowDays := int(orgconfig.LoadNumber(ctx, e.pool, orgID, "autoHealing.loopWindowDays"))
	if loopWindowDays < 1 || loopWindowDays > 90 {
		loopWindowDays = 14
	}
	loopSince := time.Now().AddDate(0, 0, -loopWindowDays)

	proposed := 0
	for clusterSignature, cluster := range bySignature {
		if len(cluster) < 2 {
			continue
		}
		// Loop-breaker: the same signature heals at most N times per window.
		attempts, err := q.CountAutoHealingAttempts(ctx, store.CountAutoHealingAttemptsParams{
			OrgID: orgID, Signature: clusterSignature, CreatedAt: loopSince,
		})
		if err != nil || int(attempts) >= maxAttempts {
			continue
		}
		candidate := cluster[0]
		patch, label := deterministicHealingPatch(candidate)
		if patch == nil {
			continue
		}
		runID := uuid.NewString()
		patchJSON, _ := json.Marshal(patch)
		metadata, _ := json.Marshal(map[string]any{
			"clusterSize": len(cluster), "nodeId": candidate.NodeID,
		})
		if err := q.InsertAutoHealingRun(ctx, store.InsertAutoHealingRunParams{
			ID: runID, OrgID: orgID, DeadLetterID: candidate.ID,
			Signature: clusterSignature, Status: "proposed",
			ProposedPatchJson: patchJSON,
			ApproachLabel:     pgtype.Text{String: label, Valid: true},
			Confidence:        pgtype.Int4{Int32: 30, Valid: true},
			LoopAttemptCount:  int32(attempts) + 1,
			Metadata:          metadata,
		}); err != nil {
			continue
		}
		// Sandbox validation with the PATCHED snapshot — write sides skip.
		var fixedWorkflow *domain.Workflow
		if fixed := applyHealingPatch(candidate.WorkflowJson, candidate.NodeID, patch); fixed != nil {
			fixedWorkflow, _ = domain.Parse(fixed)
		}
		if fixedWorkflow == nil {
			continue
		}
		validationRunID, err := e.ReplayDeadLetterAsValidation(ctx, orgID, candidate.ID, fixedWorkflow, "system:auto-healing")
		if err != nil {
			continue
		}
		_, _ = q.SetAutoHealingValidating(ctx, store.SetAutoHealingValidatingParams{
			OrgID: orgID, ID: runID,
			ValidationRunID: pgtype.Text{String: validationRunID, Valid: true},
		})
		proposed++
	}
	return proposed
}

// promoteValidatedHealingRuns is the watcher half: terminal sandbox runs
// promote (validated, pending the operator) or reject (validation_failed).
func (e *Engine) promoteValidatedHealingRuns(ctx context.Context) (promoted, rejected int) {
	q := store.New(e.pool)
	rows, err := q.ListValidatingAutoHealingRuns(ctx)
	if err != nil {
		return 0, 0
	}
	for _, row := range rows {
		outcome := "validated"
		if row.RunStatus != "succeeded" {
			outcome = "validation_failed"
		}
		changed, err := q.SetAutoHealingValidationOutcome(ctx, store.SetAutoHealingValidationOutcomeParams{
			OrgID: row.OrgID, ID: row.ID, Status: outcome,
			ValidationEvidenceLevel: row.ValidationEvidenceLevel,
		})
		if err != nil || changed == 0 {
			continue
		}
		if outcome == "validated" {
			promoted++
		} else {
			rejected++
			audit.Write(ctx, e.pool, &auth.Context{OrgID: row.OrgID, UserID: "system:auto-healing"},
				"auto_healing.failed", audit.Options{
					TargetType: "auto_healing_run", TargetID: row.ID,
					Metadata: map[string]any{"reason": "validation_failed", "runStatus": row.RunStatus},
				})
		}
	}
	return promoted, rejected
}

// deterministicHealingPatch is the pilot's $0 proposal: harden the failing
// node with a bounded retry policy + a longer timeout. Structural or
// unknown failures propose nothing (the operator's interactive AI patch
// surface handles those).
func deterministicHealingPatch(row store.ListOpenDeadLettersForHealingRow) (map[string]any, string) {
	if row.NodeID == "" || len(row.NodeJson) == 0 {
		return nil, ""
	}
	var node struct {
		Config map[string]any `json:"config"`
	}
	if err := json.Unmarshal(row.NodeJson, &node); err != nil || node.Config == nil {
		return nil, ""
	}
	patch := map[string]any{
		"retry": map[string]any{"maxAttempts": 3.0, "delayMs": 1000.0, "backoff": "exponential"},
	}
	if timeout, ok := node.Config["timeoutMs"].(float64); ok && timeout > 0 && timeout < 60_000 {
		patch["timeoutMs"] = timeout * 2
	}
	return patch, "harden_retries"
}

// applyHealingPatch merges the config patch into the failing node of the
// dead letter's workflow snapshot; nil on any shape problem (the caller
// then validates the ORIGINAL snapshot).
func applyHealingPatch(workflowJSON []byte, nodeID string, patch map[string]any) []byte {
	var document map[string]any
	if err := json.Unmarshal(workflowJSON, &document); err != nil {
		return nil
	}
	nodes, _ := document["nodes"].([]any)
	for _, rawNode := range nodes {
		node, ok := rawNode.(map[string]any)
		if !ok || node["id"] != nodeID {
			continue
		}
		config, _ := node["config"].(map[string]any)
		if config == nil {
			config = map[string]any{}
		}
		for key, value := range patch {
			config[key] = value
		}
		node["config"] = config
		fixed, err := json.Marshal(document)
		if err != nil {
			return nil
		}
		return fixed
	}
	return nil
}

// RunAutoHealingSweep loops the scan on an interval until the context ends.
func (e *Engine) RunAutoHealingSweep(ctx context.Context, every time.Duration, logger *slog.Logger) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		result := e.SweepAutoHealing(ctx)
		if result.Proposed > 0 || result.Promoted > 0 || result.Rejected > 0 {
			logger.Info("auto-healing sweep", "orgs", result.OrgsScanned,
				"proposed", result.Proposed, "promoted", result.Promoted, "rejected", result.Rejected)
		}
	}
}
