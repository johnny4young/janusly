package domain

import (
	"strings"
	"testing"
)

func TestResolveScheduleConfig(t *testing.T) {
	resolved, err := ResolveScheduleConfig(map[string]any{
		"cronExpression": " 0 9 1 * * ", "enabled": false,
	})
	if err != nil || resolved.CronExpression != "0 9 1 * *" || resolved.Enabled {
		t.Fatalf("resolved schedule: %+v err=%v", resolved, err)
	}

	cases := []struct {
		name    string
		config  map[string]any
		message string
		exact   bool
	}{
		{"legacy field", map[string]any{"cron": "0 9 * * *"}, "cronExpression is required", false},
		{"wrong field count", map[string]any{"cronExpression": "0 9 * *"}, "5-field cron expression", false},
		{"invalid cron", map[string]any{"cronExpression": "60 9 * * *"}, "valid cron expression", false},
		{"invalid string enabled", map[string]any{"cronExpression": "0 9 * * *", "enabled": "yes"}, "schedule.enabled must be a boolean when set, got: string", true},
		{"invalid numeric enabled", map[string]any{"cronExpression": "0 9 * * *", "enabled": float64(1)}, "schedule.enabled must be a boolean when set, got: number", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ResolveScheduleConfig(tc.config)
			if err == nil || (tc.exact && err.Error() != tc.message) || (!tc.exact && !strings.Contains(err.Error(), tc.message)) {
				t.Fatalf("got %v, want %q", err, tc.message)
			}
		})
	}
}
