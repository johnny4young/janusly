// AI cost governance, ported from the reference's checkBudget/gateBudget:
// the monthly usage_events cost aggregate measured against the catalog's
// org budget (ai.budgetMonthlyUsd / ai.budgetWarnPercent /
// ai.budgetExceededPolicy). allowed=false ONLY when the policy is "block"
// AND the spend crossed the limit; "warn" proceeds with a deduped warning
// audit. Fail-soft everywhere: a broken spend query keeps the gate OPEN
// (the rate-limit posture) — cost governance must never become an outage.
// The org scope is the pilot's v1; per-workflow workflow_budgets rows are
// deferred with their surface.
package aibudget

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/ai"
	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/orgconfig"

	"github.com/johnny4young/janusly/internal/store"
)

func init() {
	// Reference actions written by its raw audit() writers — outside the
	// typed catalog, admitted without touching the 147 pin.
	audit.RegisterPilotAction("billing.budget.exceeded")
	audit.RegisterPilotAction("billing.budget.warned")
}

// warnDedupWindow mirrors BUDGET_WARN_DEDUP_WINDOW_MS.
const warnDedupWindow = 24 * time.Hour

// CheckResult mirrors the reference's BudgetCheckResult.
type CheckResult struct {
	Allowed                 bool     `json:"allowed"`
	MonthlyUsdSpent         float64  `json:"monthlyUsdSpent"`
	MonthlyUsdLimit         *float64 `json:"monthlyUsdLimit"`
	Policy                  string   `json:"policy"`
	WarningPercent          float64  `json:"warningPercent"`
	WarningThresholdCrossed bool     `json:"warningThresholdCrossed"`
	ExceededAt              *string  `json:"exceededAt"`
	ResolvedScope           *string  `json:"resolvedScope"`
}

// Check resolves the org budget and measures this month's spend.
func Check(ctx context.Context, pool *pgxpool.Pool, orgID string) CheckResult {
	limit := orgconfig.LoadNumber(ctx, pool, orgID, "ai.budgetMonthlyUsd")
	policy, _ := orgconfig.LoadValue(ctx, pool, orgID, "ai.budgetExceededPolicy").(string)
	warnPercent := orgconfig.LoadNumber(ctx, pool, orgID, "ai.budgetWarnPercent")
	if policy == "" {
		policy = "warn"
	}
	if warnPercent <= 0 {
		warnPercent = 80
	}
	if limit <= 0 {
		// No budget configured: the gate is a no-op.
		return CheckResult{Allowed: true, Policy: policy, WarningPercent: warnPercent}
	}

	spent := 0.0
	var summed *float64
	err := pool.QueryRow(ctx, `SELECT sum((metadata->>'costUsd')::double precision)
		FROM usage_events
		WHERE org_id = $1 AND metric = 'llm.completion'
		  AND created_at >= date_trunc('month', now())
		  AND jsonb_typeof(metadata->'costUsd') = 'number'`, orgID).Scan(&summed)
	if err == nil && summed != nil {
		spent = *summed
	}
	// A failed sum keeps the gate OPEN (fail-soft): spent stays 0.

	scope := "org"
	result := CheckResult{
		MonthlyUsdSpent: spent, MonthlyUsdLimit: &limit,
		Policy: policy, WarningPercent: warnPercent,
		WarningThresholdCrossed: spent >= limit*warnPercent/100,
		ResolvedScope:           &scope,
	}
	exceeded := spent >= limit
	result.Allowed = policy != "block" || !exceeded
	if exceeded {
		result.ExceededAt = &scope
	}
	return result
}

// CheckScoped resolves the composite budget: the workflow override (a
// workflow_budgets row with a positive limit) bites BEFORE the org
// default; a missing/zero override falls through to Check.
// Workflow spend sums this month's usage rows stamped with that
// workflowId (the recorder writes metadata.workflowId at the chokepoint).
func CheckScoped(ctx context.Context, pool *pgxpool.Pool, orgID, workflowID string) CheckResult {
	if workflowID == "" {
		return Check(ctx, pool, orgID)
	}
	row, err := store.New(pool).GetWorkflowBudget(ctx, store.GetWorkflowBudgetParams{
		OrgID: orgID, WorkflowID: workflowID,
	})
	if err != nil || row.MonthlyUsd <= 0 {
		return Check(ctx, pool, orgID)
	}
	limit := float64(row.MonthlyUsd)
	policy := row.Policy
	if policy != "block" {
		policy = "warn"
	}
	warnPercent := float64(row.WarnPercent)
	if warnPercent <= 0 {
		warnPercent = 80
	}
	spent := 0.0
	// A no-rows sum is SQL NULL: the scan errs and spend stays 0.
	if summed, err := store.New(pool).SumWorkflowSpendThisMonth(ctx, store.SumWorkflowSpendThisMonthParams{
		OrgID: orgID, WorkflowID: workflowID,
	}); err == nil {
		spent = summed
	}
	scope := "workflow"
	result := CheckResult{
		MonthlyUsdSpent: spent, MonthlyUsdLimit: &limit,
		Policy: policy, WarningPercent: warnPercent,
		WarningThresholdCrossed: spent >= limit*warnPercent/100,
		ResolvedScope:           &scope,
	}
	exceeded := spent >= limit
	result.Allowed = policy != "block" || !exceeded
	if exceeded {
		result.ExceededAt = &scope
	}
	return result
}

// Gate runs the chokepoint and writes the matching audit rows: EVERY
// block audits billing.budget.exceeded (deliberately not deduped — each
// block is a real event), a crossed warning audits billing.budget.warned
// at most once per 24h per scope.
func Gate(ctx context.Context, pool *pgxpool.Pool, orgID, userID, action string) CheckResult {
	result := Check(ctx, pool, orgID)
	if !result.Allowed {
		audit.WriteAs(ctx, pool, orgID, userID, "billing.budget.exceeded", audit.Options{
			TargetType: "ai", Metadata: map[string]any{
				"scope": result.ResolvedScope, "exceededAt": result.ExceededAt,
				"monthlyUsdSpent": result.MonthlyUsdSpent, "monthlyUsdLimit": result.MonthlyUsdLimit,
				"policy": result.Policy, "action": action,
			},
		})
		return result
	}
	if result.WarningThresholdCrossed && result.MonthlyUsdLimit != nil {
		var recent int
		err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs
			WHERE org_id = $1 AND action = 'billing.budget.warned' AND created_at >= $2`,
			orgID, time.Now().UTC().Add(-warnDedupWindow)).Scan(&recent)
		if err == nil && recent == 0 {
			audit.WriteAs(ctx, pool, orgID, userID, "billing.budget.warned", audit.Options{
				TargetType: "ai", Metadata: map[string]any{
					"scope": result.ResolvedScope, "monthlyUsdSpent": result.MonthlyUsdSpent,
					"monthlyUsdLimit": result.MonthlyUsdLimit, "warningPercent": result.WarningPercent,
					"policy": result.Policy, "action": action,
				},
			})
		}
	}
	return result
}

// GuardedGenerateText is the canonical composition every AI surface uses:
// the gate runs FIRST, and a blocked call never touches the SDK — it
// degrades straight to the fallback contract with aiError
// "budget_blocked".
func GuardedGenerateText(ctx context.Context, pool *pgxpool.Pool, client ai.Client,
	userID, action string, input ai.GenerateTextInput) (*ai.GenerateTextResult, *ai.AIError) {
	gate := Gate(ctx, pool, input.Context.OrgID, userID, action)
	if !gate.Allowed {
		return nil, &ai.AIError{Class: "budget_blocked", Message: "monthly AI budget exceeded"}
	}
	return client.GenerateText(ctx, input)
}
