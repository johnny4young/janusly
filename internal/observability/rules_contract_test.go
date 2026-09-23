package observability

import (
	"os"
	"strconv"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestEveryPrometheusAlertLinksToItsRunbookSection(t *testing.T) {
	rules, err := os.ReadFile("../../deploy/observability/prometheus/rules.yml")
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Groups []struct {
			Rules []struct {
				Alert       string            `yaml:"alert"`
				Annotations map[string]string `yaml:"annotations"`
			} `yaml:"rules"`
		} `yaml:"groups"`
	}
	if err := yaml.Unmarshal(rules, &config); err != nil {
		t.Fatalf("parse Prometheus rules: %v", err)
	}
	runbook, err := os.ReadFile("../../docs/runbooks/alerts.md")
	if err != nil {
		t.Fatal(err)
	}
	const baseURL = "https://github.com/johnny4young/janusly/blob/main/docs/runbooks/alerts.md#"
	expected := map[string]string{
		"JanuslyMetricsMissing":          "unavailable-metrics",
		"JanuslyQueueStalled":            "queue-and-workers",
		"JanuslyWorkflowQueueWaiting":    "queue-and-workers",
		"JanuslyQueueWaitDegraded":       "queue-and-workers",
		"JanuslyQueueWaitCritical":       "queue-and-workers",
		"JanuslyTerminalFailures":        "failures-and-rate-limits",
		"JanuslyWorkflowTaskFailures":    "failures-and-rate-limits",
		"JanuslyRateLimiterDegraded":     "failures-and-rate-limits",
		"JanuslyHTTPServerErrors":        "failures-and-rate-limits",
		"JanuslyFastSweepStalled":        "background-loops",
		"JanuslyAutoHealingSweepStalled": "background-loops",
		"JanuslyHourlySweepStalled":      "background-loops",
		"JanuslyDailySweepStalled":       "background-loops",
		"JanuslySweepNeverRan":           "background-loops",
		"JanuslySweepFailing":            "background-loops",
		"JanuslyDBPoolStarved":           "database-pools",
	}
	seen := make(map[string]bool, len(expected))
	for _, group := range config.Groups {
		for _, rule := range group.Rules {
			anchor, ok := expected[rule.Alert]
			if !ok {
				t.Errorf("alert %q needs an explicit runbook mapping", rule.Alert)
				continue
			}
			if seen[rule.Alert] {
				t.Errorf("alert %q is duplicated", rule.Alert)
			}
			seen[rule.Alert] = true
			if got := rule.Annotations["runbook_url"]; got != baseURL+anchor {
				t.Errorf("alert %q runbook_url = %q, want %q", rule.Alert, got, baseURL+anchor)
			}
			start := strings.Index(string(runbook), `<a id="`+anchor+`"></a>`)
			if start < 0 {
				t.Errorf("alert %q links to missing anchor %q", rule.Alert, anchor)
				continue
			}
			section := string(runbook[start:])
			if next := strings.Index(section[1:], `<a id="`); next >= 0 {
				section = section[:next+1]
			}
			if !strings.Contains(section, "`"+rule.Alert+"`") {
				t.Errorf("alert %q is not named in its linked runbook section", rule.Alert)
			}
		}
	}
	for alert := range expected {
		if !seen[alert] {
			t.Errorf("documented alert %q is missing from Prometheus rules", alert)
		}
	}
}

// The never-ran rule counts the whole closed sweep catalog. A static count
// would page every healthy instance after adding a supervised loop.
func TestNeverRanRuleMatchesSweepCatalog(t *testing.T) {
	rules, err := os.ReadFile("../../deploy/observability/prometheus/rules.yml")
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Groups []struct {
			Rules []struct {
				Alert string `yaml:"alert"`
				Expr  string `yaml:"expr"`
			} `yaml:"rules"`
		} `yaml:"groups"`
	}
	if err := yaml.Unmarshal(rules, &config); err != nil {
		t.Fatal(err)
	}
	for _, group := range config.Groups {
		for _, rule := range group.Rules {
			if rule.Alert != "JanuslySweepNeverRan" {
				continue
			}
			want := "== " + strconv.Itoa(len(SweepNames()))
			if !strings.Contains(rule.Expr, want) {
				t.Fatalf("never-ran rule must count every sweep (%s): %s", want, rule.Expr)
			}
			return
		}
	}
	t.Fatal("never-ran rule missing")
}
