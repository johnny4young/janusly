package domain

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/johnny4young/janusly/go/internal/cron"
)

// ScheduleConfig is the canonical authored schedule-node contract shared by
// validation, durable scheduler registration, and runtime execution.
type ScheduleConfig struct {
	CronExpression string
	Enabled        bool
}

// ResolveScheduleConfig validates and normalizes the schedule node config.
// Field names and error messages mirror the reference implementation.
func ResolveScheduleConfig(config map[string]any) (*ScheduleConfig, error) {
	rawExpression, ok := config["cronExpression"]
	expression, stringValue := rawExpression.(string)
	if !ok || !stringValue || strings.TrimSpace(expression) == "" {
		return nil, fmt.Errorf(`schedule.cronExpression is required (e.g. "0 9 * * *")`)
	}
	expression = strings.TrimSpace(expression)
	if len(strings.Fields(expression)) != 5 {
		return nil, fmt.Errorf("schedule.cronExpression must be a 5-field cron expression, got: %v", rawExpression)
	}
	if err := cron.Validate(expression); err != nil {
		return nil, fmt.Errorf("schedule.cronExpression must be a valid cron expression, got: %v (%v)", rawExpression, err)
	}

	enabled := true
	if rawEnabled, present := config["enabled"]; present {
		value, ok := rawEnabled.(bool)
		if !ok {
			return nil, fmt.Errorf("schedule.enabled must be a boolean when set, got: %s", javascriptTypeofJSONValue(rawEnabled))
		}
		enabled = value
	}
	return &ScheduleConfig{CronExpression: expression, Enabled: enabled}, nil
}

// javascriptTypeofJSONValue keeps validation messages byte-compatible with
// the TypeScript reference for values that can arrive in a JSON config.
func javascriptTypeofJSONValue(value any) string {
	switch value.(type) {
	case bool:
		return "boolean"
	case string:
		return "string"
	case json.Number,
		int, int8, int16, int32, int64,
		uint, uint8, uint16, uint32, uint64,
		float32, float64:
		return "number"
	default:
		return "object"
	}
}
