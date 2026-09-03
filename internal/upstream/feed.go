// Pure feed parsing for upstream health awareness (reference
// the source contract): map a provider's status JSON
// (or an HTTP probe status code) onto the closed Janusly status
// vocabulary. Zero I/O — the poller owns the network fetch and the
// fail-open behaviour on an unreachable feed.
//
// Invariants:
//   - `kind` is a closed enum; a new provider means a new parser branch.
//   - FAIL-OPEN: a parse that finds no matching component, or a feed the
//     parser cannot read, returns ok=false — the caller MUST NOT pause on
//     it (an unreachable status page must never amplify an outage by
//     pausing every tagged workflow).
package upstream

import "strings"

// Kinds is the closed provider set.
var Kinds = map[string]bool{
	"statuspage_io": true, "atlassian_statuspage": true,
	"http_probe": true, "custom_feed": true,
}

const (
	MinCheckIntervalSeconds     = 30
	MaxCheckIntervalSeconds     = 3600
	DefaultCheckIntervalSeconds = 60
	MaxExpectedComponents       = 50
)

// ParseResult is the derived outcome; Degraded is the load-bearing field.
type ParseResult struct {
	OK bool
	// ok=true fields.
	Status     string
	Degraded   bool
	Components []ComponentStatus
	// ok=false closed reason: unparseable | component_not_found |
	// no_status | unsupported_kind.
	Reason string
}

type ComponentStatus struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}

// MapStatuspageStatus maps one component-status / indicator string onto
// the closed enum; unrecognised values are `unknown` (NOT degraded).
func MapStatuspageStatus(raw any) string {
	value, ok := raw.(string)
	if !ok {
		return "unknown"
	}
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "operational", "none":
		return "operational"
	case "degraded_performance", "minor":
		return "degraded_performance"
	case "partial_outage":
		return "partial_outage"
	case "major_outage", "major", "critical":
		return "major_outage"
	case "under_maintenance", "maintenance":
		return "under_maintenance"
	default:
		return "unknown"
	}
}

// IsDegradedStatus reports whether the derived status triggers a pause.
func IsDegradedStatus(status string) bool {
	return status == "degraded_performance" || status == "partial_outage" || status == "major_outage"
}

var statusSeverity = map[string]int{
	"operational": 0, "under_maintenance": 1, "unknown": 2,
	"degraded_performance": 3, "partial_outage": 4, "major_outage": 5,
}

func worse(a, b string) string {
	if statusSeverity[a] >= statusSeverity[b] {
		return a
	}
	return b
}

func failOpen(reason string) ParseResult { return ParseResult{OK: false, Reason: reason} }

func parseStatuspageFeed(document any, expectedComponents []string) ParseResult {
	object, ok := document.(map[string]any)
	if !ok {
		return failOpen("unparseable")
	}
	if len(expectedComponents) > 0 {
		rawComponents, ok := object["components"].([]any)
		if !ok {
			return failOpen("unparseable")
		}
		byLowerName := map[string]string{}
		for _, rawComponent := range rawComponents {
			component, ok := rawComponent.(map[string]any)
			if !ok {
				continue
			}
			name, ok := component["name"].(string)
			if !ok {
				continue
			}
			byLowerName[strings.ToLower(strings.TrimSpace(name))] = MapStatuspageStatus(component["status"])
		}
		components := make([]ComponentStatus, 0, len(expectedComponents))
		overall := "operational"
		for _, wanted := range expectedComponents {
			found, present := byLowerName[strings.ToLower(strings.TrimSpace(wanted))]
			if !present {
				// Operator-config drift (renamed/removed component) is
				// surfaced, never silently paused on.
				return failOpen("component_not_found")
			}
			components = append(components, ComponentStatus{Name: wanted, Status: found})
			overall = worse(overall, found)
		}
		return ParseResult{OK: true, Status: overall, Degraded: IsDegradedStatus(overall), Components: components}
	}
	statusBlock, ok := object["status"].(map[string]any)
	if !ok {
		return failOpen("no_status")
	}
	indicator, present := statusBlock["indicator"]
	if !present {
		return failOpen("no_status")
	}
	mapped := MapStatuspageStatus(indicator)
	return ParseResult{OK: true, Status: mapped, Degraded: IsDegradedStatus(mapped), Components: []ComponentStatus{}}
}

func parseCustomFeed(document any) ParseResult {
	object, ok := document.(map[string]any)
	if !ok {
		return failOpen("unparseable")
	}
	raw, present := object["status"]
	if !present {
		return failOpen("no_status")
	}
	mapped := MapStatuspageStatus(raw)
	if mapped == "unknown" {
		return failOpen("no_status")
	}
	return ParseResult{OK: true, Status: mapped, Degraded: IsDegradedStatus(mapped), Components: []ComponentStatus{}}
}

func parseHTTPProbe(statusCode int) ParseResult {
	if statusCode >= 200 && statusCode < 300 {
		return ParseResult{OK: true, Status: "operational", Degraded: false, Components: []ComponentStatus{}}
	}
	return ParseResult{OK: true, Status: "major_outage", Degraded: true, Components: []ComponentStatus{}}
}

// ParseFeed dispatches to the right parser for the source's kind.
func ParseFeed(kind string, expectedComponents []string, document any, statusCode int) ParseResult {
	switch kind {
	case "statuspage_io", "atlassian_statuspage":
		return parseStatuspageFeed(document, expectedComponents)
	case "custom_feed":
		return parseCustomFeed(document)
	case "http_probe":
		return parseHTTPProbe(statusCode)
	default:
		return failOpen("unsupported_kind")
	}
}
