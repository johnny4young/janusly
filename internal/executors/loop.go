// Bounded execution modes for the workflow `loop` node (reference
// loop-executor.ts). Legacy `map` mode (mode omitted) remains a pure
// per-item template projection — no tools, no side effects. `for_each`
// renders EVERY item input before side effects begin (strict template
// policy fails the whole node without partially processing a batch), then
// invokes one registered tool per item through an ordered worker pool
// inside the SAME node — the node owns the concurrency; it never adds a
// queue primitive. Items ≤1,000; concurrency 1..20 (default 4); exactly
// one count-or-percentage failure budget; throws and {ok:false} envelopes
// both count as failures; per-item and aggregate diagnostics stay
// bounded. A write-side budget breach carries WriteSide=true so the
// engine never whole-node retries it.
package executors

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/tools"
)

const (
	loopMaxItems             = 1_000
	loopDefaultConcurrency   = 4
	loopMaxConcurrency       = 20
	loopItemResultMaxBytes   = 64_000
	loopResultItemsMaxBytes  = 700_000
	loopFailureSampleLimit   = 50
	loopErrorMessageMaxChars = 300
)

// normalizeItems: arrays pass through; strings split on commas with
// trimmed, empty-dropped entries; anything else is no items.
func normalizeItems(raw any) []any {
	switch value := raw.(type) {
	case []any:
		return value
	case string:
		var items []any
		for part := range strings.SplitSeq(value, ",") {
			if trimmed := strings.TrimSpace(part); trimmed != "" {
				items = append(items, trimmed)
			}
		}
		return items
	default:
		return nil
	}
}

// NewLoopExecutor builds the loop executor over the shared tool registry
// (for_each dispatches through the same interception ladder as the tool
// node).
func NewLoopExecutor(registry *tools.Registry, httpExecutors ...Func) Func {
	httpExec := NewHTTPExecutor(HTTPOptions{})
	if len(httpExecutors) > 0 && httpExecutors[0] != nil {
		httpExec = httpExecutors[0]
	}
	return func(ctx context.Context, in Input) (any, error) {
		mode, _ := in.Config["mode"].(string)
		if mode != "" && mode != "map" && mode != "for_each" {
			return nil, fmt.Errorf("loop mode %q is not executable by this backend yet", mode)
		}
		rawItems, err := grammar.MapInput(in.Config["items"], map[string]any{
			"context": in.Context, "inputs": in.Config,
		})
		if err != nil {
			return nil, err
		}
		items := normalizeItems(rawItems)
		if len(items) > loopMaxItems {
			return nil, &ExecErrorShape{
				Message: fmt.Sprintf("Loop contains %d items; maximum is %d", len(items), loopMaxItems),
				Name:    "LoopItemLimitError", Code: "LOOP_ITEM_LIMIT_EXCEEDED",
				Details: map[string]any{"count": len(items), "maxItems": loopMaxItems},
			}
		}
		if mode == "for_each" {
			return executeForEachLoop(ctx, registry, httpExec, in, items)
		}
		return executeMapLoop(in, items)
	}
}

func executeMapLoop(in Input, items []any) (any, error) {
	mapping := in.Config["mapping"]
	if mapping == nil {
		mapping = map[string]any{"item": "{{item}}", "index": "{{index}}"}
	}
	unresolvedSeen := map[string]bool{}
	var unresolved []string
	results := make([]any, 0, len(items))
	for index, item := range items {
		rendered, err := grammar.RenderTemplateWithRedactions(mapping, map[string]any{
			"context": in.Context, "inputs": in.Config,
			"item": item, "index": float64(index),
		}, grammar.RenderOptions{})
		if err != nil {
			return nil, err
		}
		for _, path := range rendered.UnresolvedPaths {
			if !unresolvedSeen[path] {
				unresolvedSeen[path] = true
				unresolved = append(unresolved, path)
			}
		}
		results = append(results, rendered.Rendered)
	}
	if len(unresolved) > 0 && in.ReportUnresolved != nil {
		if err := in.ReportUnresolved(unresolved); err != nil {
			return nil, err
		}
	}
	if in.Emit != nil {
		in.Emit("loop.completed", map[string]any{"count": len(results), "items": results})
	}
	return map[string]any{"count": len(results), "items": results}, nil
}

/* ------------------------------ for_each ------------------------------- */

type loopItemOutcome struct {
	index   int
	status  string // succeeded | skipped | failed
	result  any
	trunc   bool
	message string
	code    string
}

func loopBoundedText(value string, max int) string {
	if len(value) <= max {
		return value
	}
	return value[:max-1] + "…"
}

// boundLoopValue caps one value through the safe-persist chokepoint and
// reports whether the sentinel replaced it.
func boundLoopValue(value any, maxBytes int) (any, bool) {
	raw := grammar.SafePersistPayload(value, grammar.PersistOptions{MaxBytes: maxBytes})
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return map[string]any{"__truncated": true}, true
	}
	if record, ok := decoded.(map[string]any); ok && record["__truncated"] == true {
		return decoded, true
	}
	return decoded, false
}

func loopBudgetExceeded(failedCount, totalCount int, toleratedCount, toleratedPercentage *float64) bool {
	if toleratedCount == nil && toleratedPercentage == nil {
		return failedCount > 0
	}
	if toleratedCount != nil && float64(failedCount) > *toleratedCount {
		return true
	}
	if toleratedPercentage != nil {
		failedPercentage := 0.0
		if totalCount > 0 {
			failedPercentage = float64(failedCount) / float64(totalCount) * 100
		}
		return failedPercentage > *toleratedPercentage
	}
	return false
}

// forEachConfig is the validated shape of a for_each loop node: the tool it
// fans out to, its concurrency, and exactly one failure budget.
type forEachConfig struct {
	tool                string
	concurrency         int
	toleratedCount      *float64
	toleratedPercentage *float64
}

// forEachSummary is the aggregate a run reports: counts, the bounded
// diagnostics, and the per-item entries kept within the result budget.
type forEachSummary struct {
	details      map[string]any
	items        []any
	failedCount  int
	skippedCount int
}

func parseForEachConfig(in Input) (forEachConfig, error) {
	tool, _ := in.Config["tool"].(string)
	if tool == "" {
		return forEachConfig{}, fmt.Errorf("loop for_each requires config.tool")
	}
	cfg := forEachConfig{tool: tool, concurrency: loopDefaultConcurrency}
	if raw, present := in.Config["concurrency"]; present {
		value, ok := raw.(float64)
		if !ok || value != math.Trunc(value) || value < 1 || value > loopMaxConcurrency {
			return forEachConfig{}, fmt.Errorf("loop concurrency must be an integer between 1 and %d", loopMaxConcurrency)
		}
		cfg.concurrency = int(value)
	}
	// Exactly ONE failure budget: count or percentage, never both.
	if raw, present := in.Config["toleratedFailureCount"]; present {
		value, ok := raw.(float64)
		if !ok || math.IsNaN(value) || math.IsInf(value, 0) || value != math.Trunc(value) || value < 0 || value > loopMaxItems {
			return forEachConfig{}, fmt.Errorf("loop toleratedFailureCount must be an integer between 0 and %d", loopMaxItems)
		}
		cfg.toleratedCount = &value
	}
	if raw, present := in.Config["toleratedFailurePercentage"]; present {
		value, ok := raw.(float64)
		if !ok || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 100 {
			return forEachConfig{}, fmt.Errorf("loop toleratedFailurePercentage must be between 0 and 100")
		}
		cfg.toleratedPercentage = &value
	}
	if cfg.toleratedCount != nil && cfg.toleratedPercentage != nil {
		return forEachConfig{}, fmt.Errorf("loop accepts exactly one failure budget: toleratedFailureCount or toleratedFailurePercentage")
	}
	return cfg, nil
}

// renderForEachInputs resolves EVERY per-item template before any side
// effect starts — strict mode fails the entire node without partially
// processing.
func renderForEachInputs(in Input, items []any) ([]map[string]any, error) {
	// Resolve EVERY per-item template before starting any side effect —
	// strict mode fails the entire node without partially processing.
	inputTemplate := in.Config["input"]
	if inputTemplate == nil {
		inputTemplate = map[string]any{}
	}
	unresolvedSeen := map[string]bool{}
	var unresolved []string
	renderedInputs := make([]map[string]any, len(items))
	for index, item := range items {
		rendered, err := grammar.RenderTemplateWithRedactions(inputTemplate, map[string]any{
			"context": in.Context, "inputs": in.Config,
			"item": item, "index": float64(index),
		}, grammar.RenderOptions{})
		if err != nil {
			return nil, err
		}
		for _, path := range rendered.UnresolvedPaths {
			if !unresolvedSeen[path] {
				unresolvedSeen[path] = true
				unresolved = append(unresolved, path)
			}
		}
		asMap, ok := rendered.Rendered.(map[string]any)
		if !ok {
			asMap = map[string]any{}
		}
		renderedInputs[index] = asMap
	}
	if len(unresolved) > 0 && in.ReportUnresolved != nil {
		if err := in.ReportUnresolved(unresolved); err != nil {
			return nil, err
		}
	}
	return renderedInputs, nil
}

// runForEachItems fans the items across an ordered worker pool: the node
// owns the concurrency, and a cancelled context stops dequeuing NEW items
// cooperatively.
func runForEachItems(ctx context.Context, registry *tools.Registry, httpExec Func, in Input, cfg forEachConfig, items []any, renderedInputs []map[string]any) ([]loopItemOutcome, error) {
	// Ordered worker pool: the node owns the cfg.concurrency. A cancelled
	// context (node timeout) stops dequeuing NEW items cooperatively.
	outcomes := make([]loopItemOutcome, len(items))
	var nextIndex atomic.Int64
	workerCount := min(cfg.concurrency, len(items))
	var wg sync.WaitGroup
	for range workerCount {
		wg.Go(func() {
			for {
				index := int(nextIndex.Add(1)) - 1
				if index >= len(items) || ctx.Err() != nil {
					return
				}
				result := executeRegisteredTool(ctx, registry, httpExec, cfg.tool, renderedInputs[index], in)
				outcome := loopItemOutcome{index: index}
				switch {
				case result["skipped"] == true:
					outcome.status = "skipped"
				case result["ok"] == false:
					outcome.status = "failed"
					message, _ := result["error"].(string)
					if message == "" {
						message = "Tool returned ok=false"
					}
					outcome.message = loopBoundedText(message, loopErrorMessageMaxChars)
					if code, ok := result["code"].(string); ok {
						outcome.code = code
					} else {
						outcome.code = "TOOL_RETURNED_NOT_OK"
					}
				default:
					outcome.status = "succeeded"
					outcome.result, outcome.trunc = boundLoopValue(result, loopItemResultMaxBytes)
				}
				outcomes[index] = outcome
			}
		})
	}
	wg.Wait()
	if ctx.Err() != nil {
		return nil, &ExecErrorShape{
			Message: "Loop execution aborted", Name: "LoopExecutionAbortedError",
			Code: "LOOP_EXECUTION_ABORTED", WriteSide: !in.DryRun && registry.IsWriteSide(cfg.tool),
		}
	}
	return outcomes, nil
}

// summarizeForEach aggregates the outcomes into counts, bounded failure
// samples and per-item entries that fit the result budget.
func summarizeForEach(cfg forEachConfig, items []any, outcomes []loopItemOutcome) forEachSummary {
	// Aggregate accounting + bounded diagnostics.
	succeededCount, skippedCount := 0, 0
	var failedIndices []any
	var failureSample []any
	resultTruncatedCount := 0
	usedBytes := 2
	boundedItems := make([]any, 0, len(outcomes))
	for _, outcome := range outcomes {
		switch outcome.status {
		case "succeeded":
			succeededCount++
			if outcome.trunc {
				resultTruncatedCount++
			}
		case "skipped":
			skippedCount++
		case "failed":
			failedIndices = append(failedIndices, outcome.index)
			if len(failureSample) < loopFailureSampleLimit {
				failureSample = append(failureSample, map[string]any{
					"index": outcome.index,
					"error": map[string]any{"message": outcome.message, "code": outcome.code},
				})
			}
		}
		entry := loopItemEntry(outcome)
		serialized, _ := json.Marshal(entry)
		if usedBytes+len(serialized)+1 > loopResultItemsMaxBytes {
			entry = loopItemBudgetEntry(outcome)
			serialized, _ = json.Marshal(entry)
		}
		usedBytes += len(serialized) + 1
		boundedItems = append(boundedItems, entry)
	}
	failedCount := len(failedIndices)
	failedPercentage := 0.0
	if len(items) > 0 {
		failedPercentage = float64(failedCount) / float64(len(items)) * 100
	}
	if failedIndices == nil {
		failedIndices = []any{}
	}
	if failureSample == nil {
		failureSample = []any{}
	}
	details := map[string]any{
		"tool": cfg.tool, "count": len(items),
		"succeededCount": succeededCount, "skippedCount": skippedCount,
		"failedCount": failedCount, "failedPercentage": failedPercentage,
		"failedIndices": failedIndices, "failures": failureSample,
		"failureDetailsTruncated": failedCount > len(failureSample),
		"resultTruncatedCount":    resultTruncatedCount,
	}
	if cfg.toleratedCount != nil {
		details["toleratedFailureCount"] = *cfg.toleratedCount
	}
	if cfg.toleratedPercentage != nil {
		details["toleratedFailurePercentage"] = *cfg.toleratedPercentage
	}
	return forEachSummary{details: details, items: boundedItems, failedCount: failedCount, skippedCount: skippedCount}
}

func executeForEachLoop(ctx context.Context, registry *tools.Registry, httpExec Func, in Input, items []any) (any, error) {
	cfg, err := parseForEachConfig(in)
	if err != nil {
		return nil, err
	}
	renderedInputs, err := renderForEachInputs(in, items)
	if err != nil {
		return nil, err
	}
	if in.Emit != nil {
		payload := map[string]any{"tool": cfg.tool, "count": len(items), "concurrency": cfg.concurrency}
		if cfg.toleratedCount != nil {
			payload["toleratedFailureCount"] = *cfg.toleratedCount
		}
		if cfg.toleratedPercentage != nil {
			payload["toleratedFailurePercentage"] = *cfg.toleratedPercentage
		}
		in.Emit("loop.for_each.started", payload)
	}
	outcomes, err := runForEachItems(ctx, registry, httpExec, in, cfg, items, renderedInputs)
	if err != nil {
		return nil, err
	}
	summary := summarizeForEach(cfg, items, outcomes)
	if summary.skippedCount > 0 && in.Emit != nil {
		in.Emit("loop.dry_run.skipped", map[string]any{
			"tool": cfg.tool, "skippedCount": summary.skippedCount, "count": len(items),
		})
	}

	if loopBudgetExceeded(summary.failedCount, len(items), cfg.toleratedCount, cfg.toleratedPercentage) {
		if in.Emit != nil {
			in.Emit("loop.failure_budget.exceeded", summary.details)
		}
		return nil, &ExecErrorShape{
			Message: fmt.Sprintf("Loop failure budget exceeded: %d of %d items failed", summary.failedCount, len(items)),
			Name:    "LoopFailureBudgetExceededError", Code: "LOOP_FAILURE_BUDGET_EXCEEDED",
			Details: summary.details,
			// Effects may already have happened: never whole-node retry.
			WriteSide: !in.DryRun && registry.IsWriteSide(cfg.tool),
		}
	}

	output := map[string]any{"mode": "for_each"}
	maps.Copy(output, summary.details)
	if in.Emit != nil {
		in.Emit("loop.completed", output)
	}
	output["items"] = summary.items
	return output, nil
}

func loopItemEntry(outcome loopItemOutcome) map[string]any {
	switch outcome.status {
	case "succeeded":
		entry := map[string]any{"index": outcome.index, "status": "succeeded", "result": outcome.result}
		if outcome.trunc {
			entry["resultTruncated"] = true
		}
		return entry
	case "skipped":
		return map[string]any{"index": outcome.index, "status": "skipped", "dryRun": true}
	default:
		return map[string]any{"index": outcome.index, "status": "failed",
			"error": map[string]any{"message": outcome.message, "code": outcome.code}}
	}
}

// loopItemBudgetEntry replaces an over-budget entry with the contract's
// compact sentinel so the aggregate stays persistable.
func loopItemBudgetEntry(outcome loopItemOutcome) map[string]any {
	switch outcome.status {
	case "succeeded":
		return map[string]any{"index": outcome.index, "status": "succeeded",
			"result":          map[string]any{"__truncated": true, "reason": "loop_result_budget_exceeded"},
			"resultTruncated": true}
	case "failed":
		return map[string]any{"index": outcome.index, "status": "failed",
			"error": map[string]any{
				"message": "Failure details omitted from the per-item list; inspect the failure sample",
				"code":    "LOOP_RESULT_BUDGET_EXCEEDED",
			},
			"errorTruncated": true}
	default:
		return map[string]any{"index": outcome.index, "status": "skipped", "dryRun": true}
	}
}
