// Recovery value metrics — the north-star projection over real redrives.
// GET /recovery/metrics (both wires): median + p90 time from failure
// detection (the dead-letter row) to the run's verified terminal success
// after a replay, plus the legacy arithmetic-average MTTR for
// compatibility with the reference's older dashboard shape.
package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"time"

	"github.com/johnny4young/janusly/internal/orgconfig"
	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/store"
)

func (s *V1Server) recoveryMetricsCore(r *http.Request, rc v1Request) opResult {
	windowDays := 30
	if raw := r.URL.Query().Get("windowDays"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			windowDays = min(90, max(1, parsed))
		}
	}
	value, err := s.recoveryMetricsValue(r.Context(), rc.orgID, windowDays)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	return opOK(value)
}

// recoveryMetricsValue is the shared read-model body (the focused route
// and the coalesced Home snapshot must not drift).
func (s *V1Server) recoveryMetricsValue(ctx context.Context, orgID string, windowDays int) (map[string]any, error) {
	q := store.New(s.pool)
	stats, err := q.QueryVerifiedRecoveryStats(ctx, store.QueryVerifiedRecoveryStatsParams{
		OrgID: orgID, WindowDays: int32(windowDays),
	})
	if err != nil {
		return nil, err
	}
	since := time.Now().UTC().AddDate(0, 0, -windowDays)
	signals, err := q.QueryRecoveryDashboardSignals(ctx, store.QueryRecoveryDashboardSignalsParams{
		TargetOrg: orgID, SinceAt: &since,
	})
	if err != nil {
		return nil, err
	}
	costRows, err := q.QueryCostByProvider(ctx, store.QueryCostByProviderParams{
		TargetOrg: orgID, Since: since,
	})
	if err != nil {
		return nil, err
	}
	trendRows, err := q.QueryRecoveryMttrTrend(ctx, store.QueryRecoveryMttrTrendParams{
		OrgID: orgID, RecoveredAt: since,
	})
	if err != nil {
		return nil, err
	}
	failureRows, err := q.ListResolvedRecoveryFailureRows(ctx, store.ListResolvedRecoveryFailureRowsParams{
		OrgID: orgID, RecoveredAt: since,
	})
	if err != nil {
		return nil, err
	}

	// Operations LLM cost rollup: exact totals over the whole window,
	// bounded to 100 provider/model groups plus one explicit remainder.
	legacyCostByProvider := make([]map[string]any, 0, len(costRows))
	costByProvider := make([]map[string]any, 0, len(costRows))
	costTotal := 0.0
	inputTokens, cachedTokens, creationTokens := 0.0, 0.0, 0.0
	for _, row := range costRows {
		costTotal += row.Usd
		inputTokens += row.InputTokens
		cachedTokens += row.CachedInputTokens
		creationTokens += row.CacheCreationInputTokens
		legacyRow := map[string]any{
			"provider": row.Provider, "model": row.Model,
			"usd": row.Usd, "tokens": row.Tokens,
			"inputTokens": row.InputTokens, "cachedInputTokens": row.CachedInputTokens,
			"cacheCreationInputTokens": row.CacheCreationInputTokens,
			"calls":                    row.Calls, "aggregated": row.Aggregated,
		}
		legacyCostByProvider = append(legacyCostByProvider, legacyRow)
		costByProvider = append(costByProvider, map[string]any{
			"provider": displayProvider(row.Provider), "model": row.Model,
			"usd": row.Usd, "tokens": row.Tokens,
			"inputTokens": row.InputTokens, "cachedInputTokens": row.CachedInputTokens,
			"cacheCreationInputTokens": row.CacheCreationInputTokens,
			"calls":                    row.Calls, "aggregated": row.Aggregated,
		})
	}
	sort.SliceStable(costByProvider, func(i, j int) bool {
		return costByProvider[i]["usd"].(float64) > costByProvider[j]["usd"].(float64)
	})
	var cacheShare any
	if inputTokens > 0 {
		cacheShare = math.Min(100, cachedTokens/inputTokens*100)
	}
	costMetric := recoveryMetric(costTotal, fmt.Sprintf("$%.2f", costTotal), "neutral",
		fmt.Sprintf("Across %d providers over the last %d days.", len(costByProvider), windowDays),
		"cost.summary", map[string]any{"providerCount": len(costByProvider), "windowDays": windowDays})
	costMetric["providers"] = costByProvider
	costMetric["cache"] = map[string]any{
		"inputTokens": inputTokens, "readTokens": cachedTokens,
		"creationTokens": creationTokens, "readSharePercent": cacheShare,
	}

	// Set-once first-action latency: recovery-item transitions stamp
	// first_action_at once; item-less tenants contribute through the
	// pre-enqueue replay claim (never both for one incident).
	firstAction, err := q.QueryTimeToFirstAction(ctx, store.QueryTimeToFirstActionParams{
		OrgID: orgID, CreatedAt: since,
	})
	if err != nil {
		return nil, err
	}
	// Seven-day recurrence bound to the IMMUTABLE impact event: the fix
	// boundary is terminal success, and a same-signature later incident
	// inside the window marks it recurred (sandbox replays never count).
	recurrence, err := q.QueryRecoveryRecurrence(ctx, store.QueryRecoveryRecurrenceParams{
		OrgID: orgID, RecoveredAt: since,
	})
	if err != nil {
		return nil, err
	}

	clusters := resolvedClusterProjection(failureRows)
	verified := verifiedRecoveryProjection(stats)
	mttr := mttrProjection(stats)
	successRate := successRateProjection(signals)
	p95Latency := latencyProjection(signals.P95LatencyMs)
	approvals := approvalsProjection(signals.ApprovalsPending)
	replayRate := replayProjection(signals)
	sla := slaProjection(signals.SlaResolved, signals.SlaMet)
	firstActionMetric := firstActionProjection(firstAction)
	recurrenceMetric := recurrenceProjection(recurrence.Resolved, recurrence.Recurred)

	trend := make([]map[string]any, 0, len(trendRows))
	for _, row := range slices.Backward(trendRows) {
		trend = append(trend, map[string]any{"day": row.Day, "seconds": float64(row.MedianMs) / 1000})
	}

	hourlyCost := orgconfig.LoadNumber(ctx, s.pool, orgID, "value.hourlyCost")
	minutesSaved := orgconfig.LoadNumber(ctx, s.pool, orgID, "value.minutesSavedPerRecovery")
	baseline := orgconfig.LoadNumber(ctx, s.pool, orgID, "value.baselineMttrSeconds")
	hoursSaved := float64(clusters["value"].(int)) * minutesSaved / 60
	var mttrDelta any
	if baseline > 0 && stats.SampleSize > 0 && stats.P50Ms >= 0 {
		mttrDelta = baseline - math.Round(stats.P50Ms/1000)
	}

	var legacyMttr any
	if stats.SampleSize > 0 && stats.MttrAvgMs >= 0 {
		legacyMttr = stats.MttrAvgMs
	}
	var firstActionAvg, firstActionP95 any
	if firstAction.SampleSize > 0 && firstAction.AvgSeconds >= 0 && firstAction.P95Seconds >= 0 {
		firstActionAvg, firstActionP95 = firstAction.AvgSeconds, firstAction.P95Seconds
	}
	firstActionMetric["unit"] = "seconds"
	firstActionMetric["sampleSize"] = firstAction.SampleSize
	firstActionMetric["avgSeconds"] = firstActionAvg
	firstActionMetric["p95Seconds"] = firstActionP95
	var legacyRecurrenceRate any
	if recurrence.Resolved > 0 {
		legacyRecurrenceRate = float64(recurrence.Resolved-recurrence.Recurred) / float64(recurrence.Resolved) * 100
	}
	return map[string]any{
		"successRate":       successRate,
		"verifiedRecovery":  verified,
		"mttr":              mttr,
		"p95Latency":        p95Latency,
		"approvalsPending":  approvals,
		"replayRate":        replayRate,
		"costThisWindow":    costMetric,
		"clustersResolved":  clusters,
		"slaAttainment":     sla,
		"timeToFirstAction": firstActionMetric,
		"recurrenceRate":    recurrenceMetric,
		"valueEstimate": map[string]any{
			"hoursSaved": hoursSaved, "dollarSaved": hoursSaved * hourlyCost,
			"mttrDeltaSeconds": mttrDelta,
			"assumptions": map[string]any{
				"hourlyCost": hourlyCost, "minutesSavedPerRecovery": minutesSaved,
				"baselineMttrSeconds": baseline,
			},
		},
		"terminalRuns":    signals.Succeeded + signals.Failed + signals.Cancelled,
		"mttrTrend":       trend,
		"downtimeEndedMs": math.Max(0, stats.DowntimeEndedMs),
		// Legacy compatibility fields remain additive during the rolling cutover.
		"mttrMs": legacyMttr,
		"recurrence": map[string]any{
			"resolved": recurrence.Resolved, "recurred": recurrence.Recurred,
			"stayedFixedRate": legacyRecurrenceRate, "windowDays": 7,
		},
		"windowDays":     windowDays,
		"costByProvider": legacyCostByProvider,
	}, nil
}

func recoveryMetric(value any, display, severity, rationale, code string, meta map[string]any) map[string]any {
	result := map[string]any{
		"value": value, "display": display, "severity": severity,
		"rationale": rationale, "rationaleCode": code,
	}
	if meta != nil {
		result["rationaleMeta"] = meta
	}
	return result
}

func displayProvider(provider string) string {
	switch provider {
	case "anthropic":
		return "Anthropic"
	case "openai":
		return "OpenAI"
	case "ollama":
		return "Ollama"
	case "google":
		return "Google"
	case "mistral":
		return "Mistral"
	default:
		return provider
	}
}

func formatDurationMs(value float64) string {
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		return "—"
	}
	if value < 1000 {
		return fmt.Sprintf("%.0fms", math.Round(value))
	}
	if value < 60_000 {
		return fmt.Sprintf("%.1fs", value/1000)
	}
	minutes := int(math.Floor(value / 60_000))
	seconds := int(math.Floor(math.Mod(value, 60_000) / 1000))
	if minutes < 60 {
		if seconds > 0 {
			return fmt.Sprintf("%dm %ds", minutes, seconds)
		}
		return fmt.Sprintf("%dm", minutes)
	}
	hours, remaining := minutes/60, minutes%60
	if remaining > 0 {
		return fmt.Sprintf("%dh %dm", hours, remaining)
	}
	return fmt.Sprintf("%dh", hours)
}

func successRateProjection(row store.QueryRecoveryDashboardSignalsRow) map[string]any {
	terminal := row.Succeeded + row.Failed + row.Cancelled
	if terminal == 0 {
		return recoveryMetric(nil, "—", "neutral", "No terminal runs in the window yet.", "success_rate.empty", nil)
	}
	rate := float64(row.Succeeded) / float64(terminal) * 100
	severity := "unhealthy"
	if rate >= 95 {
		severity = "healthy"
	} else if rate >= 85 {
		severity = "warn"
	}
	return recoveryMetric(rate, fmt.Sprintf("%.1f%%", rate), severity,
		fmt.Sprintf("%d of %d terminal runs succeeded.", row.Succeeded, terminal),
		"success_rate.summary", map[string]any{"succeeded": row.Succeeded, "terminal": terminal})
}

func verifiedRecoveryProjection(stats store.QueryVerifiedRecoveryStatsRow) map[string]any {
	if stats.SampleSize == 0 || stats.P50Ms < 0 || stats.P90Ms < 0 {
		result := recoveryMetric(nil, "—", "neutral",
			"No production workflow has reached a generation-bound verified recovery in this window.",
			"verified_recovery.empty", nil)
		result["definitionVersion"] = "1"
		result["metric"] = "time_to_verified_recovery"
		result["unit"] = "milliseconds"
		result["sampleSize"] = 0
		result["p50Ms"], result["p90Ms"] = nil, nil
		return result
	}
	p50, p90 := math.Round(stats.P50Ms), math.Round(stats.P90Ms)
	severity := "unhealthy"
	if p50 <= 120_000 {
		severity = "healthy"
	} else if p50 <= 900_000 {
		severity = "warn"
	}
	p50Display, p90Display := formatDurationMs(p50), formatDurationMs(p90)
	result := recoveryMetric(p50, p50Display, severity,
		fmt.Sprintf("Median %s across %d verified recoveries · p90 %s.", p50Display, stats.SampleSize, p90Display),
		"verified_recovery.summary", map[string]any{"count": stats.SampleSize, "p50": p50Display, "p90": p90Display})
	result["definitionVersion"] = "1"
	result["metric"] = "time_to_verified_recovery"
	result["unit"] = "milliseconds"
	result["sampleSize"] = stats.SampleSize
	result["p50Ms"], result["p90Ms"] = p50, p90
	return result
}

func mttrProjection(stats store.QueryVerifiedRecoveryStatsRow) map[string]any {
	if stats.SampleSize == 0 || stats.MttrAvgMs < 0 {
		return recoveryMetric(nil, "—", "neutral",
			"No replays in the window — fallback when there's nothing to recover from.", "mttr.empty", nil)
	}
	severity := "unhealthy"
	if stats.MttrAvgMs <= 120_000 {
		severity = "healthy"
	} else if stats.MttrAvgMs <= 900_000 {
		severity = "warn"
	}
	display := formatDurationMs(stats.MttrAvgMs)
	return recoveryMetric(stats.MttrAvgMs, display, severity,
		fmt.Sprintf("Avg %s across %d replays.", display, stats.SampleSize), "mttr.summary",
		map[string]any{"avg": display, "count": stats.SampleSize})
}

func latencyProjection(p95 float64) map[string]any {
	if p95 < 0 {
		return recoveryMetric(nil, "—", "neutral",
			"Need at least 5 runs in the window to surface a stable p95.", "latency.insufficient", nil)
	}
	severity := "unhealthy"
	if p95 <= 5000 {
		severity = "healthy"
	} else if p95 <= 30_000 {
		severity = "warn"
	}
	return recoveryMetric(p95, formatDurationMs(p95), severity,
		"p95 across all runs in the window.", "latency.summary", nil)
}

func approvalsProjection(count int32) map[string]any {
	severity := "warn"
	if count == 0 {
		severity = "healthy"
	} else if count <= 5 {
		severity = "neutral"
	}
	rationale, code := fmt.Sprintf("Current state: %d runs paused at an approval node.", count), "approvals.blocked"
	if count == 0 {
		rationale, code = "Current state: no human approvals are blocking a run right now.", "approvals.none"
	}
	return recoveryMetric(count, fmt.Sprint(count), severity, rationale, code, map[string]any{"count": count})
}

func replayProjection(row store.QueryRecoveryDashboardSignalsRow) map[string]any {
	denominator := row.ReplayedSuccess + row.ReplayedAndReopened
	if denominator == 0 {
		return recoveryMetric(nil, "—", "neutral", "No replay attempts in the window yet.", "replay.empty", nil)
	}
	rate := float64(row.ReplayedSuccess) / float64(denominator) * 100
	severity := "unhealthy"
	if rate >= 90 {
		severity = "healthy"
	} else if rate >= 70 {
		severity = "warn"
	}
	return recoveryMetric(rate, fmt.Sprintf("%.1f%%", rate), severity,
		fmt.Sprintf("%d replays succeeded · %d re-failed.", row.ReplayedSuccess, row.ReplayedAndReopened),
		"replay.summary", map[string]any{
			"replayedSuccess": row.ReplayedSuccess, "replayedAndReopened": row.ReplayedAndReopened,
		})
}

func slaProjection(resolved, met int32) map[string]any {
	if resolved == 0 {
		result := recoveryMetric(nil, "—", "neutral", "No recovery items resolved in this window yet.", "sla_attainment.empty", nil)
		result["resolvedInWindow"], result["metSla"] = resolved, met
		return result
	}
	rate := float64(met) / float64(resolved) * 100
	severity := "unhealthy"
	if rate >= 90 {
		severity = "healthy"
	} else if rate >= 75 {
		severity = "warn"
	}
	result := recoveryMetric(rate, fmt.Sprintf("%.1f%%", rate), severity,
		fmt.Sprintf("%d of %d resolved within SLA.", met, resolved), "sla_attainment.summary",
		map[string]any{"metSla": met, "resolvedInWindow": resolved})
	result["resolvedInWindow"], result["metSla"] = resolved, met
	return result
}

func firstActionProjection(row store.QueryTimeToFirstActionRow) map[string]any {
	if row.SampleSize == 0 || row.AvgSeconds < 0 || row.P95Seconds < 0 {
		return recoveryMetric(nil, "—", "neutral", "No first actions recorded in this window yet.", "time_to_first_action.empty", nil)
	}
	severity := "unhealthy"
	if row.AvgSeconds <= 900 {
		severity = "healthy"
	} else if row.AvgSeconds <= 3600 {
		severity = "warn"
	}
	return recoveryMetric(row.AvgSeconds, formatDurationMs(row.AvgSeconds*1000), severity,
		fmt.Sprintf("Average first action across %d incidents.", row.SampleSize), "time_to_first_action.summary",
		map[string]any{"avg": row.AvgSeconds, "p95": row.P95Seconds, "sampleSize": row.SampleSize, "count": row.SampleSize})
}

func recurrenceProjection(resolved, recurred int32) map[string]any {
	if resolved == 0 {
		return recoveryMetric(nil, "—", "neutral", "No terminal recoveries available for recurrence analysis yet.", "recurrence.empty", nil)
	}
	held := max(int32(0), resolved-recurred)
	rate := float64(held) / float64(resolved) * 100
	severity := "unhealthy"
	if rate >= 90 {
		severity = "healthy"
	} else if rate >= 75 {
		severity = "warn"
	}
	return recoveryMetric(rate, fmt.Sprintf("%.1f%%", rate), severity,
		fmt.Sprintf("%d of %d terminal recoveries have not re-failed within seven days.", held, resolved),
		"recurrence.summary", map[string]any{"held": held, "resolved": resolved, "recurred": recurred})
}

func resolvedClusterProjection(rows []store.ListResolvedRecoveryFailureRowsRow) map[string]any {
	capped := len(rows) > 10_000
	if capped {
		rows = rows[:10_000]
	}
	signatures := map[string]bool{}
	for _, row := range rows {
		var node struct {
			Type   string `json:"type"`
			Config struct {
				Tool string `json:"tool"`
			} `json:"config"`
		}
		_ = json.Unmarshal(row.NodeJson, &node)
		normalized := signature.NormalizeJSON(row.ErrorJson, signature.Context{
			NodeID: row.NodeID, NodeType: node.Type, ToolName: node.Config.Tool,
		})
		signatures[normalized.Signature] = true
	}
	count := len(signatures)
	display := fmt.Sprintf("%d clusters", count)
	if count == 1 {
		display = "1 cluster"
	}
	if capped {
		display = "≥ " + display
	}
	severity, rationale, code := "healthy", fmt.Sprintf("%d distinct failure signatures resolved.", count), "clusters_resolved.summary"
	if count == 0 {
		severity, rationale, code = "neutral", "No failure clusters resolved in this window.", "clusters_resolved.empty"
	}
	result := recoveryMetric(count, display, severity, rationale, code,
		map[string]any{"distinctSignatures": count, "totalEntries": len(rows), "capped": capped})
	result["totalEntries"], result["capped"] = len(rows), capped
	return result
}
