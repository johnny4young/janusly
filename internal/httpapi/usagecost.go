// GET /v1/usage/costs — the estimated AI cost of a window, down to the step
// that spent it. Stored inputTokens exclude cache reads and cache writes, so
// that counter already is the uncached input.
package httpapi

import (
	"cmp"
	"net/http"
	"slices"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/aiconfig"
	"github.com/johnny4young/janusly/internal/orgconfig"
	"github.com/johnny4young/janusly/internal/store"
)

const (
	usageCostRowCap       = 10_000
	usageCostDefaultSteps = 20
	usageCostMaxSteps     = 100
	usageCostMaxModels    = 50
)

// usageCostTally keeps a null cost distinct from a measured zero: failed and
// simulated calls have no price, so they never read as $0.
type usageCostTally struct {
	Calls                    int64    `json:"calls"`
	UncachedInputTokens      int64    `json:"uncachedInputTokens"`
	CachedInputTokens        int64    `json:"cachedInputTokens"`
	CacheCreationInputTokens int64    `json:"cacheCreationInputTokens"`
	OutputTokens             int64    `json:"outputTokens"`
	CostUsd                  *float64 `json:"costUsd"`
	UnknownCostCalls         int64    `json:"unknownCostCalls"`
	SimulatedCalls           int64    `json:"simulatedCalls"`
}

// usageCostCounts is the tally shared by the exact model rollup and the step slice.
type usageCostCounts struct {
	calls, simulated, priced                   int64
	cost, input, cached, cacheCreation, output float64
}

func (t *usageCostTally) add(row usageCostCounts) {
	t.Calls += row.calls
	t.UncachedInputTokens += int64(row.input)
	t.CachedInputTokens += int64(row.cached)
	t.CacheCreationInputTokens += int64(row.cacheCreation)
	t.OutputTokens += int64(row.output)
	t.UnknownCostCalls += row.calls - row.priced - row.simulated
	t.SimulatedCalls += row.simulated
	if row.priced > 0 {
		cost := row.cost
		if t.CostUsd != nil {
			cost += *t.CostUsd
		}
		t.CostUsd = &cost
	}
}

type usageCostModel struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	usageCostTally
}

type usageCostStep struct {
	RunID        string  `json:"runId"`
	RunAvailable bool    `json:"runAvailable"`
	WorkflowName string  `json:"workflowName"`
	NodeID       *string `json:"nodeId"`
	Provider     string  `json:"provider"`
	Model        string  `json:"model"`
	usageCostTally
}

// compareUsageCost puts the highest cost first and unpriced rows last.
func compareUsageCost(a, b *usageCostTally) int {
	switch {
	case a.CostUsd == nil && b.CostUsd == nil:
		return 0
	case a.CostUsd == nil:
		return 1
	case b.CostUsd == nil:
		return -1
	}
	return cmp.Compare(*b.CostUsd, *a.CostUsd)
}

func boundedQueryInt(r *http.Request, name string, fallback, low, high int) int {
	parsed, err := strconv.Atoi(r.URL.Query().Get(name))
	if err != nil {
		return fallback
	}
	return min(high, max(low, parsed))
}

func (s *V1Server) usageCostsCore(r *http.Request, rc v1Request) opResult {
	ctx := r.Context()
	windowDays := boundedQueryInt(r, "windowDays", 30, 1, 90)
	limit := boundedQueryInt(r, "limit", usageCostDefaultSteps, 1, usageCostMaxSteps)
	modelFilter := r.URL.Query().Get("model")
	since := time.Now().UTC().AddDate(0, 0, -windowDays)
	q := store.New(s.pool)
	modelRows, err := q.ListUsageCostModels(ctx, store.ListUsageCostModelsParams{OrgID: rc.orgID, Since: since})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	stepRows, err := q.ListUsageCostSteps(ctx, store.ListUsageCostStepsParams{
		OrgID: rc.orgID, Since: since, RowCap: usageCostRowCap,
		Model: pgtype.Text{String: modelFilter, Valid: modelFilter != ""},
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}

	var totals, withoutRun usageCostTally
	modelsByKey := map[[2]string]*usageCostModel{}
	models := []*usageCostModel{}
	for _, row := range modelRows {
		counts := usageCostCounts{row.Calls, row.SimulatedCalls, row.PricedCalls,
			row.CostUsd, row.InputTokens, row.CachedInputTokens, row.CacheCreationInputTokens, row.OutputTokens}
		totals.add(counts)
		if row.WithoutRun {
			withoutRun.add(counts)
		}
		key := [2]string{row.Provider, row.Model}
		model := modelsByKey[key]
		if model == nil {
			model = &usageCostModel{Provider: displayProvider(row.Provider), Model: row.Model}
			modelsByKey[key] = model
			models = append(models, model)
		}
		model.add(counts)
	}

	var sliceCalls int64
	var coveredSince *time.Time
	steps := make([]usageCostStep, 0, len(stepRows))
	for _, row := range stepRows {
		sliceCalls += row.Calls
		if coveredSince == nil || row.OldestAt.Before(*coveredSince) {
			coveredSince = &row.OldestAt
		}
		step := usageCostStep{RunID: row.RunID, Provider: displayProvider(row.Provider), Model: row.Model}
		if row.NodeID != "" {
			step.NodeID = &row.NodeID
		}
		step.add(usageCostCounts{row.Calls, row.SimulatedCalls, row.PricedCalls,
			row.CostUsd, row.InputTokens, row.CachedInputTokens, row.CacheCreationInputTokens, row.OutputTokens})
		steps = append(steps, step)
	}
	// Totals and models are exact; only the steps list can stop short of the window.
	stepsTruncated := sliceCalls >= usageCostRowCap
	if !stepsTruncated {
		coveredSince = nil
	}

	// Stable over the query's grouped order, so equal costs never reshuffle.
	slices.SortStableFunc(models, func(a, b *usageCostModel) int {
		return compareUsageCost(&a.usageCostTally, &b.usageCostTally)
	})
	slices.SortStableFunc(steps, func(a, b usageCostStep) int {
		return compareUsageCost(&a.usageCostTally, &b.usageCostTally)
	})
	stepsTotal, modelsTotal := len(steps), len(models)
	steps = steps[:min(limit, stepsTotal)]
	models = models[:min(usageCostMaxModels, modelsTotal)]

	runIDs := make([]string, len(steps))
	for i, step := range steps {
		runIDs[i] = step.RunID
	}
	runs, err := q.ListUsageCostRuns(ctx, store.ListUsageCostRunsParams{OrgID: rc.orgID, RunIds: runIDs})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	workflowNames := make(map[string]string, len(runs))
	for _, run := range runs {
		workflowNames[run.ID] = run.WorkflowName
	}
	for i := range steps {
		steps[i].WorkflowName, steps[i].RunAvailable = workflowNames[steps[i].RunID]
	}

	client, _ := aiconfig.Resolve(ctx, s.pool, rc.orgID)
	return opOK(map[string]any{
		"windowDays": windowDays, "retentionDays": int(orgconfig.LoadNumber(ctx, s.pool, rc.orgID, "retention.usageEventsDays")),
		"aiConfigured":   client.Configured(),
		"stepsTruncated": stepsTruncated, "stepsCoveredSince": timeOrNull(coveredSince), "rowCap": usageCostRowCap,
		"stepsTotal": stepsTotal, "modelsTotal": modelsTotal,
		"totals": totals, "withoutRun": withoutRun, "steps": steps, "models": models,
	})
}
