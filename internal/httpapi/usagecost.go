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

func (t *usageCostTally) add(row store.ListUsageCostGroupsRow) {
	t.Calls += row.Calls
	t.UncachedInputTokens += int64(row.InputTokens)
	t.CachedInputTokens += int64(row.CachedInputTokens)
	t.CacheCreationInputTokens += int64(row.CacheCreationInputTokens)
	t.OutputTokens += int64(row.OutputTokens)
	t.UnknownCostCalls += row.Calls - row.PricedCalls - row.SimulatedCalls
	t.SimulatedCalls += row.SimulatedCalls
	if row.PricedCalls > 0 {
		cost := row.CostUsd
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
	q := store.New(s.pool)
	groups, err := q.ListUsageCostGroups(ctx, store.ListUsageCostGroupsParams{
		OrgID: rc.orgID, Since: time.Now().UTC().AddDate(0, 0, -windowDays), RowCap: usageCostRowCap,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}

	var totals, withoutRun usageCostTally
	modelsByKey := map[[2]string]*usageCostModel{}
	models := []*usageCostModel{}
	steps := []usageCostStep{}
	for _, row := range groups {
		totals.add(row)
		key := [2]string{row.Provider, row.Model}
		model := modelsByKey[key]
		if model == nil {
			model = &usageCostModel{Provider: displayProvider(row.Provider), Model: row.Model}
			modelsByKey[key] = model
			models = append(models, model)
		}
		model.add(row)
		if row.RunID == "" {
			withoutRun.add(row)
			continue
		}
		if modelFilter != "" && row.Model != modelFilter {
			continue
		}
		step := usageCostStep{RunID: row.RunID, Provider: displayProvider(row.Provider), Model: row.Model}
		if row.NodeID != "" {
			step.NodeID = &row.NodeID
		}
		step.add(row)
		steps = append(steps, step)
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
		"aiConfigured": client.Configured(),
		"truncated":    totals.Calls >= usageCostRowCap, "rowCap": usageCostRowCap,
		"stepsTotal": stepsTotal, "modelsTotal": modelsTotal,
		"totals": totals, "withoutRun": withoutRun, "steps": steps, "models": models,
	})
}
