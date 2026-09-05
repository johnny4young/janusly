// Workflow health rollup + recovery before/after delta (reference
// workflows-routes.ts health section). Health = the 0–100 score across
// the last 30 days of run activity plus the static readiness signal as
// the safety dimension; the delta route splits the SAME window by a
// version cutoff (before < afterVersion ≤ after) and adds the run-status
// counter, the same-failure check by normalized signature, and the
// MIN_RUNS gate so the dialog can render "gathering data" honestly.
package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/health"
	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/store"
	"github.com/johnny4young/janusly/internal/workflowreadiness"
)

const defaultHealthWindowDays = 30

type recoveryDelta struct {
	Score         int      `json:"score"`
	P95LatencyMs  *float64 `json:"p95LatencyMs"`
	CostPerRunUsd *float64 `json:"costPerRunUsd"`
}

type recentRunsAgainstAfter struct {
	TotalRuns int `json:"totalRuns"`
	Succeeded int `json:"succeeded"`
	Failed    int `json:"failed"`
	Running   int `json:"running"`
}

type sameFailureSinceApply struct {
	Count               int      `json:"count"`
	SampleDeadLetterIDs []string `json:"sampleDeadLetterIds"`
	PriorSignature      string   `json:"priorSignature"`
}

type priorWorkflowVersion struct {
	Version   int    `json:"version"`
	VersionID string `json:"versionId"`
}

type workflowHealthDelta struct {
	WorkflowID             string                 `json:"workflowId"`
	AfterVersion           int                    `json:"afterVersion"`
	WindowDays             int                    `json:"windowDays"`
	HasEnoughData          bool                   `json:"hasEnoughData"`
	Before                 health.Score           `json:"before"`
	After                  health.Score           `json:"after"`
	Delta                  *recoveryDelta         `json:"delta"`
	RecentRunsAgainstAfter recentRunsAgainstAfter `json:"recentRunsAgainstAfter"`
	SameFailureSinceApply  *sameFailureSinceApply `json:"sameFailureSinceApply"`
	PriorVersion           *priorWorkflowVersion  `json:"priorVersion"`
}

func healthSignalsFromRow(row store.QueryWorkflowHealthSignalsRow) health.Signals {
	signals := health.Signals{
		TotalRuns: int(row.TotalRuns), SuccessCount: int(row.SuccessCount),
		FailureCount: int(row.FailureCount), RetryCount: int(row.RetryCount),
		DlqOpenCount: int(row.DlqOpenCount),
		TotalCostUsd: row.TotalCostUsd, TotalTokens: row.TotalTokens,
		VersionCount: int(row.VersionCount),
	}
	// Below five terminal runs the p95 is noise — neutral instead. The
	// SQL side answers -1 when no terminal run carries a duration.
	if row.P95LatencyMs >= 0 && signals.TotalRuns >= 5 {
		value := row.P95LatencyMs
		signals.P95LatencyMs = &value
	}
	return signals
}

func parsePersistedWorkflowSlo(raw json.RawMessage) (*health.Slo, error) {
	trimmed := bytes.TrimSpace(raw)
	// PostgreSQL jsonb cannot contain an empty JSON document. pgx therefore
	// returns zero bytes here only when the nullable slo_json column is SQL
	// NULL; treat that representation exactly like the explicit JSON null used
	// by the write contract. Non-empty malformed documents still fail closed.
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &fields); err != nil || fields == nil || len(fields) != 6 {
		return nil, errors.New("malformed workflow SLO")
	}
	for _, field := range []string{
		"successRatePercent", "mttrSeconds", "p95DurationMs",
		"budgetBlocksPerWindow", "stuckWaitingNodesMax", "windowDays",
	} {
		if _, present := fields[field]; !present {
			return nil, errors.New("incomplete workflow SLO")
		}
	}
	var persisted workflowSloBody
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&persisted); err != nil || !validWorkflowSlo(persisted) {
		return nil, errors.New("invalid workflow SLO")
	}
	floatThreshold := func(value *int) *float64 {
		if value == nil {
			return nil
		}
		converted := float64(*value)
		return &converted
	}
	windowDays := persisted.WindowDays
	return &health.Slo{
		SuccessRatePercent:    persisted.SuccessRatePercent,
		MttrSeconds:           floatThreshold(persisted.MttrSeconds),
		P95DurationMs:         floatThreshold(persisted.P95DurationMs),
		BudgetBlocksPerWindow: floatThreshold(persisted.BudgetBlocksPerWindow),
		StuckWaitingNodesMax:  floatThreshold(persisted.StuckWaitingNodesMax),
		WindowDays:            &windowDays,
	}, nil
}

// resolveWorkflowHealthContext loads the tenant-gated latest version, its
// parsed workflow, merged readiness issues, and the declared SLO.
func (s *V1Server) resolveWorkflowHealthContext(
	r *http.Request, rc v1Request, workflowID string,
) (*domain.Workflow, []health.ReadinessIssue, *health.Slo, *opResult) {
	ctx := r.Context()
	q := store.New(s.pool)
	fail := func(status int, code, message string) *opResult {
		res := opError(status, code, message, nil)
		return &res
	}
	if _, err := q.GetWorkflow(ctx, store.GetWorkflowParams{ID: workflowID, OrgID: rc.orgID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, nil, fail(http.StatusNotFound, "workflow_not_found", "Workflow not found")
		}
		return nil, nil, nil, fail(http.StatusInternalServerError, "internal_error", "Internal error")
	}
	snapshot, err := q.GetLatestWorkflowHealthSnapshot(ctx, store.GetLatestWorkflowHealthSnapshotParams{
		OrgID: rc.orgID, WorkflowID: workflowID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, nil, fail(http.StatusNotFound, "workflows_no_versions", "Workflow has no versions")
		}
		return nil, nil, nil, fail(http.StatusInternalServerError, "internal_error", "Internal error")
	}
	wf, _ := domain.Parse(snapshot.DagJson)
	if wf == nil {
		return nil, nil, nil, fail(http.StatusUnprocessableEntity, "workflows_version_malformed", "Workflow version is malformed")
	}
	readiness, err := workflowreadiness.Evaluate(ctx, s.pool, rc.orgID, wf)
	if err != nil {
		return nil, nil, nil, fail(http.StatusInternalServerError, "internal_error", "Internal error")
	}
	issues := make([]health.ReadinessIssue, 0, len(readiness.Issues))
	for _, issue := range readiness.Issues {
		issues = append(issues, health.ReadinessIssue{Code: issue.Code, Severity: issue.Severity})
	}

	slo, err := parsePersistedWorkflowSlo(snapshot.SloJson)
	if err != nil {
		return nil, nil, nil, fail(http.StatusInternalServerError, "internal_error", "Internal error")
	}
	return wf, issues, slo, nil
}

func workflowHealthFacts(wf *domain.Workflow) health.WorkflowFacts {
	facts := health.WorkflowFacts{}
	for _, node := range wf.Nodes {
		switch node.Type {
		case "ai", "agent", "multi_agent":
			facts.AiNodeCount++
		case "approval":
			facts.HasApprovalNode = true
		}
	}
	return facts
}

// workflowHealthCore backs BOTH wires: the legacy raw GET returns the score
// itself, while the /v1 alias places that same score directly under `data`.
func (s *V1Server) workflowHealthCore(r *http.Request, rc v1Request) opResult {
	workflowID := r.URL.Query().Get("workflowId")
	if workflowID == "" {
		return opError(http.StatusBadRequest, "workflows_workflow_id_required", "workflowId is required", nil)
	}
	wf, issues, slo, bad := s.resolveWorkflowHealthContext(r, rc, workflowID)
	if bad != nil {
		return *bad
	}
	since := time.Now().AddDate(0, 0, -defaultHealthWindowDays)
	row, err := store.New(s.pool).QueryWorkflowHealthSignals(r.Context(), store.QueryWorkflowHealthSignalsParams{
		WorkflowID: workflowID, OrgID: rc.orgID, Since: &since,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	signals := healthSignalsFromRow(row)
	score := health.Compute(workflowHealthFacts(wf), issues, signals, slo)
	return opOK(score)
}

// parseIntegerNumber mirrors Number(...) + Number.isInteger(...) for the
// query values the public API accepts (for example `2.0`
// and `1e1`). The result is bounded to Postgres integer because workflow
// versions use that exact storage type.
func parseIntegerNumber(raw string) (int, bool) {
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || math.Trunc(value) != value ||
		value < math.MinInt32 || value > math.MaxInt32 {
		return 0, false
	}
	return int(value), true
}

func buildRecoveryDelta(before, after health.Score, beforeSignals, afterSignals health.Signals) *recoveryDelta {
	if afterSignals.TotalRuns < health.MinRunsForDelta {
		return nil
	}
	var p95Delta *float64
	if beforeSignals.P95LatencyMs != nil && afterSignals.P95LatencyMs != nil {
		p95Delta = new(*afterSignals.P95LatencyMs - *beforeSignals.P95LatencyMs)
	}
	var costDelta *float64
	if beforeSignals.TotalRuns > 0 && afterSignals.TotalRuns > 0 {
		beforeCost := beforeSignals.TotalCostUsd / float64(beforeSignals.TotalRuns)
		afterCost := afterSignals.TotalCostUsd / float64(afterSignals.TotalRuns)
		costDelta = new(afterCost - beforeCost)
	}
	return &recoveryDelta{
		Score: after.Score - before.Score, P95LatencyMs: p95Delta, CostPerRunUsd: costDelta,
	}
}

func (s *V1Server) mountWorkflowHealthRoutes(mux *http.ServeMux) {
	s.route(mux, "GET /workflows/health", routeGate{auth.RoleViewer, "workflows.read"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.workflowHealthCore(r, rc))
	})

	s.route(mux, "GET /workflows/health/delta", routeGate{auth.RoleViewer, "workflows.read"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		query := r.URL.Query()
		workflowID := query.Get("workflowId")
		afterVersion, validAfterVersion := parseIntegerNumber(query.Get("afterVersion"))
		if workflowID == "" {
			writeUnversioned(w, opError(http.StatusBadRequest, "workflows_workflow_id_required", "workflowId is required", nil))
			return
		}
		if !validAfterVersion || afterVersion < 1 {
			writeUnversioned(w, opError(http.StatusBadRequest, "workflows_after_version_invalid",
				"afterVersion must be a positive integer", nil))
			return
		}
		windowDays := defaultHealthWindowDays
		if raw := query.Get("windowDays"); raw != "" {
			if parsed, ok := parseIntegerNumber(raw); ok {
				windowDays = min(30, max(1, parsed))
			}
		}
		priorSignature := query.Get("priorFailureSignature")
		if len(priorSignature) > 256 {
			priorSignature = ""
		}

		wf, issues, slo, bad := s.resolveWorkflowHealthContext(r, rc, workflowID)
		if bad != nil {
			writeUnversioned(w, *bad)
			return
		}
		ctx := r.Context()
		q := store.New(s.pool)
		since := time.Now().AddDate(0, 0, -windowDays)
		cutoff := int32(afterVersion)
		beforeRow, errBefore := q.QueryWorkflowHealthSignals(ctx, store.QueryWorkflowHealthSignalsParams{
			WorkflowID: workflowID, OrgID: rc.orgID, Since: &since,
			BeforeVersion: pgtype.Int4{Int32: cutoff, Valid: true},
		})
		afterRow, errAfter := q.QueryWorkflowHealthSignals(ctx, store.QueryWorkflowHealthSignalsParams{
			WorkflowID: workflowID, OrgID: rc.orgID, Since: &since,
			FromVersion: pgtype.Int4{Int32: cutoff, Valid: true},
		})
		if errBefore != nil || errAfter != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		facts := workflowHealthFacts(wf)
		beforeSignals := healthSignalsFromRow(beforeRow)
		afterSignals := healthSignalsFromRow(afterRow)
		before := health.Compute(facts, issues, beforeSignals, slo)
		after := health.Compute(facts, issues, afterSignals, slo)

		recentRow, err := q.QueryRecentRunsAgainstWorkflowVersion(ctx,
			store.QueryRecentRunsAgainstWorkflowVersionParams{
				WorkflowID: workflowID, OrgID: rc.orgID, Since: &since, FromVersion: cutoff,
			})
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		recent := recentRunsAgainstAfter{
			TotalRuns: int(recentRow.TotalRuns), Succeeded: int(recentRow.Succeeded),
			Failed: int(recentRow.Failed), Running: int(recentRow.Running),
		}

		// Same-failure check: post-cutoff dead letters whose normalized
		// signature matches the caller-supplied prior failure. Only that
		// caller value is echoed; freshly-derived signatures never cross
		// this response boundary.
		var sameFailure *sameFailureSinceApply
		if priorSignature != "" {
			rows, err := q.ListRecentDeadLettersForWorkflowDelta(ctx, store.ListRecentDeadLettersForWorkflowDeltaParams{
				WorkflowID: workflowID, OrgID: rc.orgID, CreatedAt: &since,
				FromVersion: pgtype.Int4{Int32: cutoff, Valid: true},
			})
			if err != nil {
				writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
				return
			}
			sameFailure = &sameFailureSinceApply{
				SampleDeadLetterIDs: make([]string, 0, min(5, len(rows))), PriorSignature: priorSignature,
			}
			for _, row := range rows {
				normalized := signature.NormalizeJSON(row.ErrorJson, signature.Context{
					NodeID: row.NodeID, NodeType: nodeTypeOf(row.NodeJson),
				})
				if normalized.Signature != priorSignature {
					continue
				}
				sameFailure.Count++
				if len(sameFailure.SampleDeadLetterIDs) < 5 {
					sameFailure.SampleDeadLetterIDs = append(sameFailure.SampleDeadLetterIDs, row.ID)
				}
			}
		}

		var priorVersion *priorWorkflowVersion
		if afterVersion > 1 {
			row, err := q.GetWorkflowVersionByNumber(ctx, store.GetWorkflowVersionByNumberParams{
				WorkflowID: workflowID, OrgID: rc.orgID, Version: cutoff - 1,
			})
			switch {
			case err == nil:
				priorVersion = &priorWorkflowVersion{Version: int(row.Version), VersionID: row.ID}
			case errors.Is(err, pgx.ErrNoRows):
				// A missing historical row is a valid no-rollback posture.
			default:
				writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
				return
			}
		}

		writeUnversioned(w, opOK(workflowHealthDelta{
			WorkflowID: workflowID, AfterVersion: afterVersion, WindowDays: windowDays,
			HasEnoughData: afterSignals.TotalRuns >= health.MinRunsForDelta,
			Before:        before, After: after,
			Delta:                  buildRecoveryDelta(before, after, beforeSignals, afterSignals),
			RecentRunsAgainstAfter: recent, SameFailureSinceApply: sameFailure,
			PriorVersion: priorVersion,
		}))
	})
}
