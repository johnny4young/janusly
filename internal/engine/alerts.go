// Recovery alerting dispatcher — the runtime's port of the contract's
// alert subsystem core: enabled policies for (org, trigger) evaluate
// their per-trigger parameters against the event payload, a cooldown
// dedupe (policy + dedupe key) suppresses repeat noise, and delivery
// runs through the SAME SSRF-guarded HTTP chokepoint the `http` node
// uses (webhook channels deliver for real; slack/email/github record an
// honest delivery_failed until the integrations wave). Producers NEVER
// break their primary flow: DispatchAlert swallows every error and is
// called strictly AFTER the producing transaction commits.
package engine

import (
	"context"
	"encoding/json"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/store"
)

// AlertTriggers is the closed trigger catalog (reference ALERT_TRIGGERS).
var AlertTriggers = map[string]bool{
	"dlq.entry_created":                true,
	"failure_cluster.threshold":        true,
	"budget.blocked":                   true,
	"limiter.degraded":                 true,
	"workflow.slo_breach":              true,
	"approval.stalled":                 true,
	"recovery_item.created":            true,
	"recovery_item.sla_breached":       true,
	"workflow.schedule_anomaly":        true,
	"credential.expiring":              true,
	"workflow.circuit_breaker_tripped": true,
}

// alertHTTPDeliver posts one JSON payload through the http-node
// chokepoint (SSRF validation + pinned dial + bounded body inherited).
var alertHTTPDeliver = func(ctx context.Context, url string, payload map[string]any) error {
	execute := executors.NewHTTPExecutor(executors.HTTPOptions{})
	_, err := execute(ctx, executors.Input{Config: map[string]any{
		"url": url, "method": "POST", "body": payload, "timeoutMs": 5000,
	}})
	return err
}

func alertStringList(params map[string]any, key string) []string {
	raw, _ := params[key].([]any)
	out := make([]string, 0, len(raw))
	for _, entry := range raw {
		if s, ok := entry.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func alertListAllows(list []string, value string) bool {
	if len(list) == 0 {
		return true
	}
	return slices.Contains(list, value)
}

// alertPolicyMatches evaluates the runtime-supported per-trigger parameter
// filters against the payload; an unknown parameter never blocks (the
// policy write validated shape, matching stays permissive-by-default).
func alertPolicyMatches(trigger string, params map[string]any, payload map[string]any) bool {
	workflowID, _ := payload["workflowId"].(string)
	if !alertListAllows(alertStringList(params, "workflowIds"), workflowID) {
		return false
	}
	switch trigger {
	case "dlq.entry_created":
		if pattern, ok := params["errorSignaturePattern"].(string); ok && pattern != "" {
			sig, _ := payload["errorSignature"].(string)
			if !strings.Contains(sig, pattern) {
				return false
			}
		}
	case "recovery_item.created", "recovery_item.sla_breached":
		severity, _ := payload["severity"].(string)
		if !alertListAllows(alertStringList(params, "severities"), severity) {
			return false
		}
	}
	return true
}

// DispatchAlert evaluates every enabled policy for (org, trigger) and
// records one alert_dispatches row per fired policy. Never returns an
// error — alerting must not break the producer.
func (e *Engine) DispatchAlert(ctx context.Context, orgID, trigger string, payload map[string]any) {
	if !AlertTriggers[trigger] {
		return
	}
	q := store.New(e.pool)
	policies, err := q.ListEnabledAlertPolicies(ctx, store.ListEnabledAlertPoliciesParams{
		OrgID: orgID, Trigger: trigger,
	})
	if err != nil {
		slog.Warn("[alerts] policy scan failed", "trigger", trigger, "error", err)
		return
	}
	dedupeKey, _ := payload["dedupeKey"].(string)
	if dedupeKey == "" {
		dedupeKey = trigger
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return
	}
	for _, policy := range policies {
		var params map[string]any
		_ = json.Unmarshal(policy.Parameters, &params)
		if !alertPolicyMatches(trigger, params, payload) {
			continue
		}
		// Cooldown: a same-key dispatch inside the window suppresses this one.
		since := time.Now().UTC().Add(-time.Duration(policy.CooldownSeconds) * time.Second)
		recent, err := q.CountRecentAlertDispatches(ctx, store.CountRecentAlertDispatchesParams{
			OrgID: orgID, PolicyID: policy.ID, DedupeKey: dedupeKey, DispatchedAt: since,
		})
		if err != nil || recent > 0 {
			continue
		}
		var channels []map[string]any
		_ = json.Unmarshal(policy.Channels, &channels)
		results := make([]map[string]any, 0, len(channels))
		delivered := 0
		for _, channel := range channels {
			channelType, _ := channel["type"].(string)
			switch channelType {
			case "webhook":
				channelParams, _ := channel["params"].(map[string]any)
				url, _ := channelParams["url"].(string)
				err := alertHTTPDeliver(ctx, url, map[string]any{
					"trigger": trigger, "policy": policy.Name, "payload": payload,
				})
				if err != nil {
					results = append(results, map[string]any{
						"type": channelType, "status": "failed", "error": err.Error(),
					})
					continue
				}
				delivered++
				results = append(results, map[string]any{"type": channelType, "status": "delivered"})
			default:
				// Slack/email/github delivery needs the integrations wave —
				// the durable record stays honest (same posture as the
				// recovery-item handoff).
				results = append(results, map[string]any{
					"type": channelType, "status": "failed", "error": "dispatcher_unavailable",
				})
			}
		}
		outcome := "failed"
		if delivered > 0 {
			outcome = "delivered"
		}
		resultsJSON, _ := json.Marshal(results)
		if err := q.InsertAlertDispatch(ctx, store.InsertAlertDispatchParams{
			ID: e.newID(), OrgID: orgID, PolicyID: policy.ID, DedupeKey: dedupeKey,
			Outcome: outcome, ChannelResults: resultsJSON, TriggerPayload: payloadJSON,
		}); err != nil {
			slog.Warn("[alerts] dispatch record failed", "policyId", policy.ID, "error", err)
		}
	}
}
