// Trigger passthrough executors. The API ingestion seam accepts and persists
// the event; these executors re-run the domain-owned authored-config grammar
// and expose one normalized event envelope to downstream nodes.
package executors

import (
	"context"
	"time"

	"github.com/johnny4young/janusly/internal/domain"
)

func executeWebhookReceived(_ context.Context, in Input) (any, error) {
	if err := domain.ValidateWebhookReceivedConfig(in.Config); err != nil {
		return nil, err
	}
	return triggerOutput("webhook_received", in.Context), nil
}

func executeEmailReceived(_ context.Context, in Input) (any, error) {
	if err := domain.ValidateEmailReceivedConfig(in.Config); err != nil {
		return nil, err
	}
	return triggerOutput("email_received", in.Context), nil
}

func executePagerDutyIncident(_ context.Context, in Input) (any, error) {
	if err := domain.ValidatePagerDutyIncidentConfig(in.Config); err != nil {
		return nil, err
	}
	return triggerOutput("pagerduty_incident", in.Context), nil
}

func executeFileDropped(_ context.Context, in Input) (any, error) {
	if err := domain.ValidateFileDroppedConfig(in.Config); err != nil {
		return nil, err
	}
	return triggerOutput("file_dropped", in.Context), nil
}

func executeMcpServerEvent(_ context.Context, in Input) (any, error) {
	if err := domain.ValidateMcpServerEventConfig(in.Config); err != nil {
		return nil, err
	}
	return triggerOutput("mcp_server_event", in.Context), nil
}

func triggerOutput(nodeType string, runContext map[string]any) map[string]any {
	return map[string]any{
		"triggeredBy": nodeType,
		"triggeredAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"event":       readTriggerEvent(runContext),
	}
}

// readTriggerEvent pulls the normalized inbound event out of the run input.
// Manual starts have no event and intentionally receive an empty object.
func readTriggerEvent(runContext map[string]any) map[string]any {
	if input, ok := runContext["input"].(map[string]any); ok {
		if event, ok := input["event"].(map[string]any); ok {
			return event
		}
	}
	return map[string]any{}
}

func executeSchedule(_ context.Context, in Input) (any, error) {
	config, err := domain.ResolveScheduleConfig(in.Config)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"triggeredAt":    time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"cronExpression": config.CronExpression,
	}, nil
}
