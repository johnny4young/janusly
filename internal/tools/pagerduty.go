// PagerDuty incident read, deterministic policy, and mutation tools
// (reference the source contract).
//
// The V3 flow is: signed trigger (httpapi/pagerduty.go) → authoritative
// read (pagerduty.incident.get) → deterministic policy evaluation
// (pagerduty.policy.evaluate — pure, no I/O, registered with a real
// Execute so it works without run deps) → acknowledge → snooze. The three
// API-backed tools ride the shared integration chokepoint (credential
// gate kind `pagerduty_api_token`, org+credential rate limit, usage row,
// FetchHTTPTarget-only egress via deps.Fetch).
//
// IsWithinPagerDutyWorkingHours shares internal/zonedwindow with the
// generic time.window tool; the BIAS stays here: that tool rejects
// malformed configuration, this evaluator absorbs it as "working hours"
// so broken policy can never authorize a mutation. Don't unify them.
package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/johnny4young/janusly/internal/zonedwindow"
)

const (
	pagerDutyResponseMaxBytes    = 256 * 1024
	pagerDutyDefaultRateLimitMin = 120
	pagerDutySnoozeMinSeconds    = 60
	pagerDutySnoozeMaxSeconds    = 604_800
	pagerDutyIncidentTitleMax    = 2_000
	pagerDutyWorkingWindowsMax   = 14
)

var pagerDutyActionableDefaults = map[string]bool{
	"incident.triggered":  true,
	"incident.reassigned": true,
	"incident.escalated":  true,
	"incident.reopened":   true,
}

// WorkingWindow is one recurring local working-hours window.
type WorkingWindow struct {
	Days  []int
	Start string
	End   string
}

// IsWithinPagerDutyWorkingHours is the safe-default working-hours
// evaluator. Invalid policy data is treated as working time, so malformed
// configuration cannot authorize mutations. Zone resolution and
// midnight-crossing matching come from internal/zonedwindow, shared with
// the generic time.window tool; only the bias differs (see file header).
func IsWithinPagerDutyWorkingHours(at time.Time, timeZone string, windows []WorkingWindow) bool {
	if len(windows) == 0 {
		return true
	}
	clock, ok := zonedwindow.ZonedClock(at, timeZone)
	if !ok {
		return true
	}
	for _, window := range windows {
		start, startOK := zonedwindow.ParseLocalMinute(window.Start)
		end, endOK := zonedwindow.ParseLocalMinute(window.End)
		if !startOK || !endOK || start == end || len(window.Days) == 0 {
			return true
		}
		if zonedwindow.Contains(clock, window.Days, start, end) {
			return true
		}
	}
	return false
}

// pagerDutyAPIBase resolves the regional API host, honoring the explicit
// local simulator gate (both env vars, like the contract).
func pagerDutyAPIBase(region string) string {
	if os.Getenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR") == "true" {
		if raw := strings.TrimSpace(os.Getenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL")); raw != "" {
			return strings.TrimRight(raw, "/") + "/pagerduty"
		}
	}
	if region == "eu" {
		return "https://api.eu.pagerduty.com"
	}
	return "https://api.pagerduty.com"
}

func pagerDutyHeaders(token, requesterEmail string) map[string]string {
	return map[string]string{
		"accept":        "application/vnd.pagerduty+json;version=2",
		"authorization": "Token token=" + token,
		"content-type":  "application/json",
		"from":          requesterEmail,
	}
}

// pagerDutyIncident is the bounded projection persisted downstream.
type pagerDutyIncident struct {
	ID              string   `json:"id"`
	Status          string   `json:"status"`
	Title           *string  `json:"title"`
	Urgency         *string  `json:"urgency"`
	ServiceID       *string  `json:"serviceId"`
	AssignedUserIDs []string `json:"assignedUserIds"`
}

var pagerDutyIncidentStatuses = map[string]bool{"triggered": true, "acknowledged": true, "resolved": true}

// parsePagerDutyIncidentBody projects `{"incident": {...}}` into the
// bounded shape, or nil when the body doesn't carry a valid incident.
func parsePagerDutyIncidentBody(body string) *pagerDutyIncident {
	var parsed struct {
		Incident map[string]any `json:"incident"`
	}
	if err := json.Unmarshal([]byte(body), &parsed); err != nil || parsed.Incident == nil {
		return nil
	}
	return projectPagerDutyIncident(parsed.Incident)
}

func projectPagerDutyIncident(record map[string]any) *pagerDutyIncident {
	id, _ := record["id"].(string)
	status, _ := record["status"].(string)
	if id == "" || !pagerDutyIncidentStatuses[status] {
		return nil
	}
	incident := &pagerDutyIncident{ID: id, Status: status, AssignedUserIDs: []string{}}
	if title, ok := record["title"].(string); ok {
		if len(title) > pagerDutyIncidentTitleMax {
			title = title[:pagerDutyIncidentTitleMax]
		}
		incident.Title = &title
	}
	if urgency, ok := record["urgency"].(string); ok && urgency != "" {
		incident.Urgency = &urgency
	}
	if service, ok := record["service"].(map[string]any); ok {
		if serviceID, ok := service["id"].(string); ok && serviceID != "" {
			incident.ServiceID = &serviceID
		}
	}
	if assignments, ok := record["assignments"].([]any); ok {
		for _, rawAssignment := range assignments {
			assignment, ok := rawAssignment.(map[string]any)
			if !ok {
				continue
			}
			assignee, ok := assignment["assignee"].(map[string]any)
			if !ok {
				continue
			}
			if userID, ok := assignee["id"].(string); ok && userID != "" {
				incident.AssignedUserIDs = append(incident.AssignedUserIDs, userID)
			}
		}
	}
	return incident
}

// parseProjectedPagerDutyIncident reads the PROJECTED shape the policy
// input carries (what pagerduty.incident.get returned downstream):
// id/status/title/urgency/serviceId/assignedUserIds. The raw API shape
// (assignments/service) is projectPagerDutyIncident's job.
func parseProjectedPagerDutyIncident(record map[string]any) *pagerDutyIncident {
	id, _ := record["id"].(string)
	status, _ := record["status"].(string)
	rawUsers, hasUsers := record["assignedUserIds"].([]any)
	if id == "" || !pagerDutyIncidentStatuses[status] || !hasUsers {
		return nil
	}
	incident := &pagerDutyIncident{ID: id, Status: status, AssignedUserIDs: []string{}}
	for _, rawUser := range rawUsers {
		if user, ok := rawUser.(string); ok && user != "" {
			incident.AssignedUserIDs = append(incident.AssignedUserIDs, user)
		}
	}
	if title, ok := record["title"].(string); ok {
		incident.Title = &title
	}
	if urgency, ok := record["urgency"].(string); ok && urgency != "" {
		incident.Urgency = &urgency
	}
	if serviceID, ok := record["serviceId"].(string); ok && serviceID != "" {
		incident.ServiceID = &serviceID
	}
	return incident
}

func (i *pagerDutyIncident) toMap() map[string]any {
	asAny := func(value *string) any {
		if value == nil {
			return nil
		}
		return *value
	}
	users := make([]any, 0, len(i.AssignedUserIDs))
	for _, user := range i.AssignedUserIDs {
		users = append(users, user)
	}
	return map[string]any{
		"id": i.ID, "status": i.Status, "title": asAny(i.Title),
		"urgency": asAny(i.Urgency), "serviceId": asAny(i.ServiceID),
		"assignedUserIds": users,
	}
}

func pagerDutyTools() []Definition {
	unavailable := func(_ context.Context, _ map[string]any) (map[string]any, error) {
		return map[string]any{"ok": false, "error": "integration tools require run context", "latencyMs": 0}, nil
	}
	connectionFields := []Field{
		{Name: "credential", Type: "string", Required: true},
		{Name: "requesterEmail", Type: "string", Required: true},
		{Name: "region", Type: "string"},
		{Name: "rateLimitPerMin", Type: "number"},
	}
	incidentFields := append(append([]Field{}, connectionFields...),
		Field{Name: "incidentId", Type: "string", Required: true})
	connectionExample := map[string]any{
		"credential": "pagerduty-api", "requesterEmail": "operator@example.com",
		"region": "us", "incidentId": "{{context.on_pagerduty.output.event.incidentId}}",
	}
	return []Definition{
		{
			Name:         "pagerduty.incident.get",
			Description:  "Read one authoritative PagerDuty incident using a stored API token.",
			Required:     []string{"credential", "requesterEmail", "incidentId"},
			Optional:     []string{"region", "rateLimitPerMin"},
			Fields:       incidentFields,
			InputExample: connectionExample,
			WriteSide:    false,
			Execute:      unavailable,
		},
		{
			Name:        "pagerduty.policy.evaluate",
			Description: "Evaluate PagerDuty event type, assignment, filters, and working hours without an LLM.",
			Required:    []string{"eventType", "occurredAt", "receivedAt", "incident", "pagerDutyUserId", "timeZone", "workingHours"},
			Optional:    []string{"serviceIds", "urgencies", "actionableEventTypes"},
			Fields: []Field{
				{Name: "eventType", Type: "string", Required: true},
				{Name: "occurredAt", Type: "string", Required: true},
				{Name: "receivedAt", Type: "string", Required: true},
				{Name: "incident", Type: "object", Required: true},
				{Name: "pagerDutyUserId", Type: "string", Required: true},
				{Name: "timeZone", Type: "string", Required: true},
				{Name: "workingHours", Type: "array", Required: true},
				{Name: "serviceIds", Type: "array"},
				{Name: "urgencies", Type: "array"},
				{Name: "actionableEventTypes", Type: "array"},
			},
			InputExample: map[string]any{
				"eventType":       "{{context.on_pagerduty.output.event.eventType}}",
				"occurredAt":      "{{context.on_pagerduty.output.event.occurredAt}}",
				"receivedAt":      "{{context.on_pagerduty.output.event.receivedAt}}",
				"incident":        "{{context.load_incident.output.result.incident}}",
				"pagerDutyUserId": "PAGERDUTY_USER_ID",
				"timeZone":        "UTC",
				"workingHours":    []any{map[string]any{"days": []any{1.0, 2.0, 3.0, 4.0, 5.0}, "start": "09:00", "end": "17:00"}},
			},
			WriteSide: false,
			Execute:   executePagerDutyPolicyEvaluate,
		},
		{
			Name:         "pagerduty.incident.acknowledge",
			Description:  "Acknowledge one PagerDuty incident using a stored API token.",
			Required:     []string{"credential", "requesterEmail", "incidentId"},
			Optional:     []string{"region", "rateLimitPerMin"},
			Fields:       incidentFields,
			InputExample: connectionExample,
			WriteSide:    true,
			Execute:      unavailable,
		},
		{
			Name:        "pagerduty.incident.snooze",
			Description: "Snooze one PagerDuty incident for a bounded duration using a stored API token.",
			Required:    []string{"credential", "requesterEmail", "incidentId", "durationSeconds"},
			Optional:    []string{"region", "rateLimitPerMin"},
			Fields: append(append([]Field{}, incidentFields...),
				Field{Name: "durationSeconds", Type: "number", Required: true}),
			InputExample: map[string]any{
				"credential": "pagerduty-api", "requesterEmail": "operator@example.com",
				"region": "us", "incidentId": "{{context.on_pagerduty.output.event.incidentId}}",
				"durationSeconds": 43_200,
			},
			WriteSide: true,
			Execute:   unavailable,
		},
	}
}

// executePagerDutyPolicyEvaluate is the pure decision ladder — exact
// reason order from the contract. Malformed runtime input answers
// {shouldAct:false, reason:"invalid_runtime_input"}; it never errors.
func executePagerDutyPolicyEvaluate(_ context.Context, input map[string]any) (map[string]any, error) {
	start := time.Now()
	latency := func() int { return int(time.Since(start).Milliseconds()) }
	answer := func(shouldAct bool, reason string, eventOutside, receivedOutside bool) (map[string]any, error) {
		return map[string]any{
			"ok": true, "shouldAct": shouldAct, "reason": reason,
			"eventOutsideWorkingHours":    eventOutside,
			"receivedOutsideWorkingHours": receivedOutside,
			"latencyMs":                   latency(),
		}, nil
	}
	eventType, _ := input["eventType"].(string)
	pagerDutyUserID, _ := input["pagerDutyUserId"].(string)
	timeZone, _ := input["timeZone"].(string)
	occurredAtRaw, _ := input["occurredAt"].(string)
	receivedAtRaw, _ := input["receivedAt"].(string)
	incidentRaw, _ := input["incident"].(map[string]any)
	occurredAt, occurredErr := time.Parse(time.RFC3339, occurredAtRaw)
	receivedAt, receivedErr := time.Parse(time.RFC3339, receivedAtRaw)
	var incident *pagerDutyIncident
	if incidentRaw != nil {
		incident = parseProjectedPagerDutyIncident(incidentRaw)
	}
	if incident == nil || occurredErr != nil || receivedErr != nil {
		return answer(false, "invalid_runtime_input", false, false)
	}

	actionable := pagerDutyActionableDefaults
	if rawActionable, present := input["actionableEventTypes"].([]any); present {
		actionable = map[string]bool{}
		for _, rawType := range rawActionable {
			if typed, ok := rawType.(string); ok {
				actionable[typed] = true
			}
		}
	}
	serviceIDs := stringSlice(input["serviceIds"])
	urgencies := stringSlice(input["urgencies"])
	windows := parseWorkingWindows(input["workingHours"])

	eventOutside := !IsWithinPagerDutyWorkingHours(occurredAt, timeZone, windows)
	receivedOutside := !IsWithinPagerDutyWorkingHours(receivedAt, timeZone, windows)
	reason := "matched"
	switch {
	case !actionable[eventType]:
		reason = "event_not_actionable"
	case incident.Status == "resolved":
		reason = "incident_resolved"
	case !containsString(incident.AssignedUserIDs, pagerDutyUserID):
		reason = "user_not_assigned"
	case len(serviceIDs) > 0 && (incident.ServiceID == nil || !containsString(serviceIDs, *incident.ServiceID)):
		reason = "service_filtered"
	case len(urgencies) > 0 && (incident.Urgency == nil || !containsString(urgencies, *incident.Urgency)):
		reason = "urgency_filtered"
	case !eventOutside:
		reason = "event_in_working_hours"
	case !receivedOutside:
		reason = "received_in_working_hours"
	}
	return answer(reason == "matched", reason, eventOutside, receivedOutside)
}

func stringSlice(raw any) []string {
	items, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if typed, ok := item.(string); ok {
			out = append(out, typed)
		}
	}
	return out
}

func containsString(haystack []string, needle string) bool {
	return slices.Contains(haystack, needle)
}

// parseWorkingWindows converts the wire shape leniently — malformed
// entries surface as invalid windows the ABSORBING evaluator treats as
// working hours (never as authorization to act).
func parseWorkingWindows(raw any) []WorkingWindow {
	items, ok := raw.([]any)
	if !ok || len(items) == 0 || len(items) > pagerDutyWorkingWindowsMax {
		return nil
	}
	windows := make([]WorkingWindow, 0, len(items))
	for _, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			// A non-object entry is malformed policy: an empty-days window
			// makes the evaluator absorb it as working time.
			windows = append(windows, WorkingWindow{})
			continue
		}
		window := WorkingWindow{}
		if rawDays, ok := entry["days"].([]any); ok {
			for _, rawDay := range rawDays {
				if day, ok := rawDay.(float64); ok && day == math.Trunc(day) && day >= 0 && day <= 6 {
					window.Days = append(window.Days, int(day))
				}
			}
		}
		window.Start, _ = entry["start"].(string)
		window.End, _ = entry["end"].(string)
		windows = append(windows, window)
	}
	return windows
}

// executePagerDutyAPICall runs the three API-backed tools through the
// chokepoint deps. `name` selects method/path/body; every failure mode
// answers the envelope.
func executePagerDutyAPICall(ctx context.Context, name string, input map[string]any, deps *IntegrationDeps) map[string]any {
	start := time.Now()
	latency := func() int { return int(time.Since(start).Milliseconds()) }
	if deps == nil || deps.Gate == nil || deps.Fetch == nil {
		return envelopeError("integration tools require run context", 0)
	}
	credential, _ := input["credential"].(string)
	requesterEmail, _ := input["requesterEmail"].(string)
	incidentID, _ := input["incidentId"].(string)
	region, _ := input["region"].(string)
	if region == "" {
		region = "us"
	}
	if credential == "" || requesterEmail == "" || !strings.Contains(requesterEmail, "@") ||
		incidentID == "" || len(incidentID) > 300 || (region != "us" && region != "eu") {
		return envelopeError(name+" requires credential, requesterEmail, and incidentId", latency())
	}
	record := func(ok bool, statusCode int, errMessage string) {
		if deps.Record != nil {
			deps.Record(name, credential, ok, statusCode, errMessage, latency())
		}
	}

	rateLimit := pagerDutyDefaultRateLimitMin
	if deps.RateLimitPerMin != nil {
		rateLimit = deps.RateLimitPerMin("pagerduty", pagerDutyDefaultRateLimitMin)
	}
	if override, ok := input["rateLimitPerMin"].(float64); ok && override >= 1 && override <= 10_000 {
		rateLimit = int(override)
	}
	token, gateError := deps.Gate(ctx, name, "pagerduty_api_token", credential, rateLimit)
	if gateError != "" {
		record(false, 0, gateError)
		return envelopeError(gateError, latency())
	}

	method, path := "GET", "/incidents/"+url.PathEscape(incidentID)
	var body []byte
	switch name {
	case "pagerduty.incident.acknowledge":
		method = "PUT"
		body, _ = json.Marshal(map[string]any{"incident": map[string]any{
			"id": incidentID, "type": "incident_reference", "status": "acknowledged",
		}})
	case "pagerduty.incident.snooze":
		duration, ok := input["durationSeconds"].(float64)
		if !ok || duration != math.Trunc(duration) ||
			duration < pagerDutySnoozeMinSeconds || duration > pagerDutySnoozeMaxSeconds {
			return envelopeError("pagerduty.incident.snooze requires durationSeconds in 60..604800", latency())
		}
		method, path = "POST", path+"/snooze"
		body, _ = json.Marshal(map[string]any{"duration": int(duration)})
	}

	statusCode, responseBody, fetchError := deps.Fetch(ctx,
		method, pagerDutyAPIBase(region)+path, pagerDutyHeaders(token, requesterEmail), body)
	ok := fetchError == "" && statusCode >= 200 && statusCode < 300

	if name == "pagerduty.incident.get" {
		var incident *pagerDutyIncident
		if ok {
			incident = parsePagerDutyIncidentBody(responseBody)
		}
		ok = ok && incident != nil && incident.ID == incidentID
		if !ok {
			message := "pagerduty incident read failed"
			if statusCode > 0 {
				message = fmt.Sprintf("pagerduty incident read failed (%d)", statusCode)
			}
			record(false, statusCode, message)
			result := envelopeError(message, latency())
			if statusCode > 0 {
				result["statusCode"] = statusCode
			}
			return result
		}
		record(true, statusCode, "")
		return map[string]any{"ok": true, "incident": incident.toMap(), "statusCode": statusCode, "latencyMs": latency()}
	}

	verb := "acknowledge"
	if name == "pagerduty.incident.snooze" {
		verb = "snooze"
	}
	if !ok {
		message := "pagerduty " + verb + " failed"
		if statusCode > 0 {
			message = fmt.Sprintf("pagerduty %s failed (%d)", verb, statusCode)
		}
		record(false, statusCode, message)
		result := envelopeError(message, latency())
		if statusCode > 0 {
			result["statusCode"] = statusCode
		}
		return result
	}
	record(true, statusCode, "")
	return map[string]any{"ok": true, "statusCode": statusCode, "latencyMs": latency()}
}
