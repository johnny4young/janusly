// GET /run/usage — the per-run usage summary, ported from the reference:
// tenancy first (an unknown or cross-org run is 403 Forbidden), then the
// newest bounded slice of the run's usage_events aggregated into the
// operator-safe shape {loadedRows, truncated, rowCap, llm{...},
// memory{...}}. The aggregation tolerates malformed metadata the same
// way the reference does — non-numeric fields simply don't count.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/store"
)

// runUsageRowCap mirrors the reference's RUN_USAGE_ROW_CAP.
const runUsageRowCap = 10_000

type runMemoryKind struct {
	Kind     string `json:"kind"`
	Recalls  int    `json:"recalls"`
	Commits  int    `json:"commits"`
	Failures int    `json:"failures"`
}

func (s *V1Server) runUsageCore(r *http.Request, rc v1Request) opResult {
	runID := r.URL.Query().Get("runId")
	if runID == "" {
		return opError(http.StatusBadRequest, "runs_run_id_required", "runId is required", nil)
	}
	if _, err := store.New(s.pool).GetRun(r.Context(), store.GetRunParams{
		ID: runID, OrgID: rc.orgID,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusForbidden, "runs_forbidden", "Forbidden", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	rows, err := store.New(s.pool).ListRunUsageSlice(r.Context(), store.ListRunUsageSliceParams{
		OrgID: rc.orgID, RunID: pgtype.Text{String: runID, Valid: true},
		Limit: runUsageRowCap + 1,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	truncated := len(rows) > runUsageRowCap
	if truncated {
		rows = rows[:runUsageRowCap]
	}

	llm := map[string]any{}
	var calls, inputTokens, outputTokens, totalTokens, cachedInput, cacheCreation, unknownCost int
	var knownCostUsd float64
	memoryByKind := map[string]*runMemoryKind{}
	for _, row := range rows {
		var metadata map[string]any
		_ = json.Unmarshal(row.Metadata, &metadata)
		switch row.Metric {
		case "llm.completion":
			calls++
			inputTokens += safeCount(metadata["inputTokens"])
			outputTokens += safeCount(metadata["outputTokens"])
			totalTokens += int(row.Quantity)
			cachedInput += safeCount(metadata["cachedInputTokens"])
			cacheCreation += safeCount(metadata["cacheCreationInputTokens"])
			if cost, ok := metadata["costUsd"].(float64); ok && cost >= 0 {
				knownCostUsd += cost
			} else {
				unknownCost++
			}
		case "memory.recall", "memory.commit":
			kind, _ := metadata["kind"].(string)
			if kind == "" {
				kind = "unknown"
			}
			entry := memoryByKind[kind]
			if entry == nil {
				entry = &runMemoryKind{Kind: kind}
				memoryByKind[kind] = entry
			}
			if row.Metric == "memory.recall" {
				entry.Recalls++
			} else {
				entry.Commits++
			}
			if ok, present := metadata["ok"].(bool); present && !ok {
				entry.Failures++
			}
		}
	}
	llm["calls"] = calls
	llm["inputTokens"] = inputTokens
	llm["outputTokens"] = outputTokens
	llm["totalTokens"] = totalTokens
	llm["cachedInputTokens"] = cachedInput
	llm["cacheCreationInputTokens"] = cacheCreation
	llm["knownCostUsd"] = knownCostUsd
	llm["unknownCostCalls"] = unknownCost

	kinds := make([]runMemoryKind, 0, len(memoryByKind))
	recalls, commits, failures := 0, 0, 0
	for _, entry := range memoryByKind {
		kinds = append(kinds, *entry)
		recalls += entry.Recalls
		commits += entry.Commits
		failures += entry.Failures
	}
	sort.Slice(kinds, func(i, j int) bool {
		left, right := kinds[i], kinds[j]
		if lv, rv := left.Recalls+left.Commits, right.Recalls+right.Commits; lv != rv {
			return lv > rv
		}
		return left.Kind < right.Kind
	})

	return opOK(map[string]any{
		"loadedRows": len(rows), "truncated": truncated, "rowCap": runUsageRowCap,
		"llm": llm,
		"memory": map[string]any{
			"recalls": recalls, "commits": commits, "failures": failures, "kinds": kinds,
		},
	})
}

// safeCount reads a non-negative numeric metadata field, tolerating any
// malformed shape as zero.
func safeCount(value any) int {
	number, ok := value.(float64)
	if !ok || number < 0 {
		return 0
	}
	return int(number)
}

func (s *V1Server) mountRunUsageRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /run/usage", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.runUsageCore(r, rc))
	}))
}
