// Billing surfaces (T-516; reference apps/api/src/routes/billing-routes.ts
// + packages/engine/src/billing.ts): bounded usage reporting (flat summary
// + closed-enum dimensional breakdown + CSV export) and the budget
// surfaces (composite read envelope + the per-workflow override write).
// Both usage paths read the same 30-day / 10k-row slice — the
// unbounded-scan invariant stays intact.
package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/aibudget"
	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/auth"
	"github.com/johnny4young/janusly/go/internal/store"
)

const usageWindowDays = 30

var usageBreakdownDimensions = map[string]bool{
	"provider": true, "model": true, "mode": true, "day": true, "node": true, "workflow": true,
}

/* ------------------------------ aggregation ------------------------------ */

type usageBucketState struct {
	bucket            map[string]any
	costSum           float64
	costRowsWithValue int
	latencies         []float64
}

func usageDimensionValue(row store.ListUsageEventsForBillingRow, metadata map[string]any, dim string) string {
	str := func(key string) string {
		if value, ok := metadata[key].(string); ok && value != "" {
			return value
		}
		return "unknown"
	}
	switch dim {
	case "provider":
		return str("provider")
	case "model":
		return str("model")
	case "mode":
		return str("mode")
	case "day":
		if row.CreatedAt != nil {
			return row.CreatedAt.UTC().Format("2006-01-02")
		}
		return "unknown"
	case "node":
		return str("nodeId")
	case "workflow":
		return str("workflowId")
	}
	return "unknown"
}

func usagePercentile(sorted []float64, p float64) any {
	if len(sorted) == 0 {
		return nil
	}
	idx := int(float64(len(sorted))*p+0.999999) - 1
	if idx < 0 {
		idx = 0
	}
	if idx > len(sorted)-1 {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

// aggregateUsageBreakdown is the reference's pure aggregator: buckets keyed
// `dim=value|…`, per-bucket token/call/fallback totals, cost null when NO
// row carries a cost (never coerce-to-zero), latency p50/p95/avg.
func aggregateUsageBreakdown(rows []store.ListUsageEventsForBillingRow, dimensions []string) []map[string]any {
	dims := make([]string, 0, len(dimensions))
	seen := map[string]bool{}
	for _, dim := range dimensions {
		if !seen[dim] {
			seen[dim] = true
			dims = append(dims, dim)
		}
	}
	if len(dims) == 0 {
		return []map[string]any{}
	}
	states := map[string]*usageBucketState{}
	order := []string{}
	for _, row := range rows {
		metadata := map[string]any{}
		if len(row.Metadata) > 0 {
			_ = json.Unmarshal(row.Metadata, &metadata)
		}
		keyParts := make([]string, len(dims))
		for i, dim := range dims {
			keyParts[i] = dim + "=" + usageDimensionValue(row, metadata, dim)
		}
		key := strings.Join(keyParts, "|")
		state, ok := states[key]
		if !ok {
			bucket := map[string]any{
				"key": key, "quantity": 0.0, "callCount": 0.0, "fallbackCount": 0.0,
				"costUsd": nil,
				"latency": map[string]any{"p50Ms": nil, "p95Ms": nil, "avgMs": nil},
			}
			for _, dim := range dims {
				bucket[dim] = usageDimensionValue(row, metadata, dim)
			}
			state = &usageBucketState{bucket: bucket}
			states[key] = state
			order = append(order, key)
		}
		state.bucket["callCount"] = state.bucket["callCount"].(float64) + 1
		state.bucket["quantity"] = state.bucket["quantity"].(float64) + float64(row.Quantity)
		if metadata["mode"] == "fallback" {
			state.bucket["fallbackCount"] = state.bucket["fallbackCount"].(float64) + 1
		}
		if cost, ok := metadata["costUsd"].(float64); ok {
			state.costSum += cost
			state.costRowsWithValue++
		}
		if latency, ok := metadata["latencyMs"].(float64); ok {
			state.latencies = append(state.latencies, latency)
		}
	}
	out := make([]map[string]any, 0, len(order))
	for _, key := range order {
		state := states[key]
		if state.costRowsWithValue > 0 {
			state.bucket["costUsd"] = state.costSum
		}
		if len(state.latencies) > 0 {
			sort.Float64s(state.latencies)
			sum := 0.0
			for _, v := range state.latencies {
				sum += v
			}
			state.bucket["latency"] = map[string]any{
				"p50Ms": usagePercentile(state.latencies, 0.5),
				"p95Ms": usagePercentile(state.latencies, 0.95),
				"avgMs": sum / float64(len(state.latencies)),
			}
		}
		out = append(out, state.bucket)
	}
	return out
}

func (s *V1Server) usageSlice(r *http.Request, rc v1Request) ([]store.ListUsageEventsForBillingRow, error) {
	since := time.Now().Add(-usageWindowDays * 24 * time.Hour)
	return store.New(s.pool).ListUsageEventsForBilling(r.Context(), store.ListUsageEventsForBillingParams{
		OrgID: rc.orgID, Since: since,
	})
}

func parseBreakdownDimensions(raw string) ([]string, string) {
	dimensions := []string{}
	for _, token := range strings.Split(raw, ",") {
		token = strings.TrimSpace(token)
		if token == "" {
			continue
		}
		if !usageBreakdownDimensions[token] {
			return nil, token
		}
		duplicate := false
		for _, existing := range dimensions {
			if existing == token {
				duplicate = true
			}
		}
		if !duplicate {
			dimensions = append(dimensions, token)
		}
	}
	return dimensions, ""
}

/* -------------------------------- routes --------------------------------- */

func (s *V1Server) billingUsageCore(r *http.Request, rc v1Request) opResult {
	dimensions, unknown := parseBreakdownDimensions(r.URL.Query().Get("breakdown"))
	if unknown != "" {
		return opError(http.StatusBadRequest, "billing_unknown_breakdown_dimension",
			"Unknown breakdown dimension: {{dimension}}", map[string]any{"dimension": unknown})
	}
	rows, err := s.usageSlice(r, rc)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	summary := map[string]any{}
	for _, row := range rows {
		current, _ := summary[row.Metric].(float64)
		summary[row.Metric] = current + float64(row.Quantity)
	}
	if len(dimensions) == 0 {
		return opOK(summary)
	}
	return opOK(map[string]any{
		"summary": summary, "breakdown": aggregateUsageBreakdown(rows, dimensions),
		"windowDays": usageWindowDays,
	})
}

var csvFormulaShape = regexp.MustCompile(`^\s*[=+\-@]`)

// csvCell applies RFC 4180 escaping + the formula-injection guard.
func csvCell(value any) string {
	s := ""
	if value != nil {
		s = fmt.Sprint(value)
	}
	if csvFormulaShape.MatchString(s) {
		s = "'" + s
	}
	if strings.ContainsAny(s, "\",\r\n") {
		s = `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
	}
	return s
}

func (s *V1Server) billingUsageExport(w http.ResponseWriter, r *http.Request, rc v1Request) {
	dimensions, unknown := parseBreakdownDimensions(r.URL.Query().Get("breakdown"))
	if unknown != "" {
		writeLegacy(w, opError(http.StatusBadRequest, "billing_unknown_breakdown_dimension",
			"Unknown breakdown dimension: {{dimension}}", map[string]any{"dimension": unknown}))
		return
	}
	if len(dimensions) == 0 {
		dimensions = []string{"workflow", "model", "day"}
	}
	rows, err := s.usageSlice(r, rc)
	if err != nil {
		writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil))
		return
	}
	breakdown := aggregateUsageBreakdown(rows, dimensions)
	var lines []string
	header := append(append([]string{}, dimensions...),
		"quantity", "callCount", "fallbackCount", "costUsd", "latencyP50Ms", "latencyP95Ms", "latencyAvgMs")
	cells := make([]string, len(header))
	for i, name := range header {
		cells[i] = csvCell(name)
	}
	lines = append(lines, strings.Join(cells, ","))
	for _, bucket := range breakdown {
		latency := bucket["latency"].(map[string]any)
		row := make([]string, 0, len(header))
		for _, dim := range dimensions {
			row = append(row, csvCell(bucket[dim]))
		}
		for _, value := range []any{
			bucket["quantity"], bucket["callCount"], bucket["fallbackCount"],
			bucket["costUsd"], latency["p50Ms"], latency["p95Ms"], latency["avgMs"],
		} {
			row = append(row, csvCell(value))
		}
		lines = append(lines, strings.Join(row, ","))
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "billing.usage.exported", audit.Options{
		Metadata: map[string]any{
			"dimensions": strings.Join(dimensions, ","),
			"rowCount":   len(breakdown), "windowDays": usageWindowDays,
		},
	})
	filename := "janusly-usage-" + time.Now().UTC().Format("2006-01-02") + ".csv"
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(strings.Join(lines, "\r\n") + "\r\n"))
}

func (s *V1Server) billingBudgetCore(r *http.Request, rc v1Request) opResult {
	workflowID := r.URL.Query().Get("workflowId")
	return opOK(checkResultEnvelope(aibudget.CheckScoped(r.Context(), s.pool, rc.orgID, workflowID)))
}

func checkResultEnvelope(result aibudget.CheckResult) map[string]any {
	return map[string]any{
		"allowed": result.Allowed, "monthlyUsdSpent": result.MonthlyUsdSpent,
		"monthlyUsdLimit": result.MonthlyUsdLimit, "policy": result.Policy,
		"warningPercent": result.WarningPercent, "warningThresholdCrossed": result.WarningThresholdCrossed,
		"exceededAt": result.ExceededAt, "resolvedScope": result.ResolvedScope,
	}
}

func (s *V1Server) workflowBudgetCore(r *http.Request, rc v1Request) opResult {
	workflowID := r.PathValue("workflowId")
	if workflowID == "" {
		return opError(http.StatusBadRequest, "billing_workflow_id_required", "workflowId path segment is required", nil)
	}
	ctx := r.Context()
	q := store.New(s.pool)
	if _, err := q.GetWorkflow(ctx, store.GetWorkflowParams{ID: workflowID, OrgID: rc.orgID}); err != nil {
		return opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil)
	}
	var body struct {
		MonthlyUsd  *float64 `json:"monthlyUsd"`
		WarnPercent *float64 `json:"warnPercent"`
		Policy      *string  `json:"policy"`
	}
	if err := decodeBody(r, &body); err != nil || body.MonthlyUsd == nil || *body.MonthlyUsd < 0 {
		return opError(http.StatusBadRequest, "billing_monthly_usd_invalid", "monthlyUsd must be a finite number >= 0", nil)
	}
	warnPercent := int32(80)
	if body.WarnPercent != nil {
		if *body.WarnPercent != float64(int(*body.WarnPercent)) || *body.WarnPercent < 0 || *body.WarnPercent > 100 {
			return opError(http.StatusBadRequest, "billing_warn_percent_invalid", "warnPercent must be an integer between 0 and 100", nil)
		}
		warnPercent = int32(*body.WarnPercent)
	}
	policy := "warn"
	if body.Policy != nil {
		if *body.Policy != "warn" && *body.Policy != "block" {
			return opError(http.StatusBadRequest, "billing_policy_invalid", "policy must be 'warn' or 'block'", nil)
		}
		policy = *body.Policy
	}
	var before map[string]any
	if existing, err := q.GetWorkflowBudget(ctx, store.GetWorkflowBudgetParams{OrgID: rc.orgID, WorkflowID: workflowID}); err == nil {
		before = map[string]any{
			"monthlyUsd": existing.MonthlyUsd, "warnPercent": existing.WarnPercent, "policy": existing.Policy,
		}
	}
	row, err := q.UpsertWorkflowBudget(ctx, store.UpsertWorkflowBudgetParams{
		ID: "wb-" + workflowID + "-" + rc.orgID, OrgID: rc.orgID, WorkflowID: workflowID,
		MonthlyUsd: float32(*body.MonthlyUsd), WarnPercent: warnPercent, Policy: policy,
		UpdatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	after := map[string]any{"monthlyUsd": row.MonthlyUsd, "warnPercent": row.WarnPercent, "policy": row.Policy}
	audit.Write(ctx, s.pool, rc.authContext, "billing.budget.configured", audit.Options{
		TargetType: "workflow", TargetID: workflowID,
		Metadata: map[string]any{"scope": "workflow", "workflowId": workflowID, "before": before, "after": after},
	})
	return opOK(map[string]any{
		"id": row.ID, "orgId": row.OrgID, "workflowId": row.WorkflowID,
		"monthlyUsd": row.MonthlyUsd, "warnPercent": row.WarnPercent, "policy": row.Policy,
		"updatedBy": textOrNull(row.UpdatedBy),
		"createdAt": timeOrNull(row.CreatedAt), "updatedAt": timeOrNull(row.UpdatedAt),
	})
}

func (s *V1Server) mountBillingRoutes(mux *http.ServeMux) {
	// The reads carry no rank/permission gate in the reference — auth-only.
	mux.HandleFunc("GET /billing/usage/export", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		s.billingUsageExport(w, r, rc)
	}))
	mux.HandleFunc("GET /billing/usage", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.billingUsageCore(r, rc))
	}))
	mux.HandleFunc("GET /billing/budget", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.billingBudgetCore(r, rc))
	}))
	s.route(mux, "POST /workflows/{workflowId}/budget", routeGate{auth.RoleAdmin, "org.config.write"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.workflowBudgetCore(r, rc))
	})
}
