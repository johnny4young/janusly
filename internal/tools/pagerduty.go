// PagerDuty incident read, deterministic policy, and mutation tools
// (reference the source contract).
//
// The V3 flow is: signed trigger (httpapi/pagerduty.go) → authoritative
// read (pagerduty.incident.get) → deterministic policy evaluation
// (pagerduty.policy.evaluate — pure, no I/O, registered with a real
// Execute so it works without run deps) → acknowledge → snooze → authoritative
// re-read → verification evidence. The three API-backed tools ride the shared
// integration chokepoint (credential
// gate kind `pagerduty_api_token`, org+credential rate limit, usage row,
// FetchHTTPTarget-only egress via deps.Fetch).
//
// IsWithinPagerDutyWorkingHours shares internal/zonedwindow with the generic
// time.window tool. The policy evaluator validates its complete window before
// calling this helper, so neither inside nor outside mode can turn malformed
// configuration into mutation authority.
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
	pagerDutyIdentifierMaxBytes  = 300
	pagerDutyAssignmentsMax      = 100
	pagerDutyPendingActionsMax   = 32
	pagerDutyWorkingWindowsMax   = 14
	pagerDutySnoozeReceiptSkew   = 5 * time.Minute
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
	if localIntegrationSimulatorEnabled() {
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
	ID              string                   `json:"id"`
	Status          string                   `json:"status"`
	Title           *string                  `json:"title"`
	Urgency         *string                  `json:"urgency"`
	ServiceID       *string                  `json:"serviceId"`
	AssignedUserIDs []string                 `json:"assignedUserIds"`
	PendingActions  []pagerDutyPendingAction `json:"pendingActions"`
}

type pagerDutyPendingAction struct {
	Type string `json:"type"`
	At   string `json:"at"`
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

// parsePagerDutyIncidentListBody projects the bulk incident-management
// response used by PUT /incidents. Janusly sends one immutable incident
// reference per request, so any empty, multi-row, malformed, or mismatched
// receipt is ambiguous mutation evidence and fails closed.
func parsePagerDutyIncidentListBody(body, expectedID string) *pagerDutyIncident {
	var parsed struct {
		Incidents []map[string]any `json:"incidents"`
	}
	if err := json.Unmarshal([]byte(body), &parsed); err != nil || len(parsed.Incidents) != 1 {
		return nil
	}
	incident := projectPagerDutyIncident(parsed.Incidents[0])
	if incident == nil || incident.ID != expectedID {
		return nil
	}
	return incident
}

func projectPagerDutyIncident(record map[string]any) *pagerDutyIncident {
	id, _ := record["id"].(string)
	status, _ := record["status"].(string)
	if id == "" || len(id) > pagerDutyIdentifierMaxBytes || !pagerDutyIncidentStatuses[status] {
		return nil
	}
	incident := &pagerDutyIncident{
		ID: id, Status: status, AssignedUserIDs: []string{}, PendingActions: []pagerDutyPendingAction{},
	}
	if title, ok := record["title"].(string); ok {
		title = truncatePagerDutyText(title, pagerDutyIncidentTitleMax)
		incident.Title = &title
	}
	if urgency, ok := record["urgency"].(string); ok && (urgency == "high" || urgency == "low") {
		incident.Urgency = &urgency
	}
	if service, ok := record["service"].(map[string]any); ok {
		if serviceID, ok := service["id"].(string); ok && serviceID != "" && len(serviceID) <= pagerDutyIdentifierMaxBytes {
			incident.ServiceID = &serviceID
		}
	}
	if assignments, ok := record["assignments"].([]any); ok {
		if len(assignments) > pagerDutyAssignmentsMax {
			return nil
		}
		seen := map[string]bool{}
		for _, rawAssignment := range assignments {
			assignment, ok := rawAssignment.(map[string]any)
			if !ok {
				return nil
			}
			assignee, ok := assignment["assignee"].(map[string]any)
			if !ok {
				return nil
			}
			userID, ok := assignee["id"].(string)
			if !ok || userID == "" || len(userID) > pagerDutyIdentifierMaxBytes {
				return nil
			}
			if !seen[userID] {
				seen[userID] = true
				incident.AssignedUserIDs = append(incident.AssignedUserIDs, userID)
			}
		}
	} else if rawAssignments, present := record["assignments"]; present && rawAssignments != nil {
		return nil
	}
	pending, ok := parsePagerDutyPendingActions(record["pending_actions"])
	if !ok {
		return nil
	}
	incident.PendingActions = pending
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
	if id == "" || len(id) > pagerDutyIdentifierMaxBytes || !pagerDutyIncidentStatuses[status] ||
		!hasUsers || len(rawUsers) > pagerDutyAssignmentsMax {
		return nil
	}
	incident := &pagerDutyIncident{
		ID: id, Status: status, AssignedUserIDs: []string{}, PendingActions: []pagerDutyPendingAction{},
	}
	seen := map[string]bool{}
	for _, rawUser := range rawUsers {
		if user, ok := rawUser.(string); ok && user != "" && len(user) <= pagerDutyIdentifierMaxBytes && !seen[user] {
			seen[user] = true
			incident.AssignedUserIDs = append(incident.AssignedUserIDs, user)
		} else if !ok || user == "" || len(user) > pagerDutyIdentifierMaxBytes {
			return nil
		}
	}
	if title, ok := record["title"].(string); ok {
		title = truncatePagerDutyText(title, pagerDutyIncidentTitleMax)
		incident.Title = &title
	}
	if urgency, ok := record["urgency"].(string); ok && (urgency == "high" || urgency == "low") {
		incident.Urgency = &urgency
	}
	if serviceID, ok := record["serviceId"].(string); ok && serviceID != "" && len(serviceID) <= pagerDutyIdentifierMaxBytes {
		incident.ServiceID = &serviceID
	}
	pending, ok := parsePagerDutyPendingActions(record["pendingActions"])
	if !ok {
		return nil
	}
	incident.PendingActions = pending
	return incident
}

func truncatePagerDutyText(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	cut := maxBytes
	for cut > 0 && (value[cut]&0xC0) == 0x80 {
		cut--
	}
	return value[:cut]
}

func parsePagerDutyPendingActions(raw any) ([]pagerDutyPendingAction, bool) {
	if raw == nil {
		return []pagerDutyPendingAction{}, true
	}
	items, ok := raw.([]any)
	if !ok || len(items) > pagerDutyPendingActionsMax {
		return nil, false
	}
	out := make([]pagerDutyPendingAction, 0, len(items))
	for _, item := range items {
		record, ok := item.(map[string]any)
		if !ok {
			return nil, false
		}
		actionType, typeOK := record["type"].(string)
		at, atOK := record["at"].(string)
		parsedAt, err := time.Parse(time.RFC3339, at)
		if !typeOK || actionType == "" || len(actionType) > 100 || !atOK || err != nil {
			return nil, false
		}
		out = append(out, pagerDutyPendingAction{
			Type: actionType, At: parsedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	return out, true
}

func pagerDutyUnacknowledgeAt(incident *pagerDutyIncident) (string, bool) {
	if incident == nil {
		return "", false
	}
	var selected time.Time
	for _, action := range incident.PendingActions {
		if action.Type != "unacknowledge" {
			continue
		}
		at, err := time.Parse(time.RFC3339, action.At)
		if err == nil && at.After(selected) {
			selected = at
		}
	}
	if selected.IsZero() {
		return "", false
	}
	return selected.UTC().Format(time.RFC3339Nano), true
}

func pagerDutySnoozeReceiptMatches(receipt string, started, completed time.Time, durationSeconds int) bool {
	deadline, err := time.Parse(time.RFC3339, receipt)
	if err != nil {
		return false
	}
	duration := time.Duration(durationSeconds) * time.Second
	lower := started.Add(duration).Add(-pagerDutySnoozeReceiptSkew)
	upper := completed.Add(duration).Add(pagerDutySnoozeReceiptSkew)
	return !deadline.Before(lower) && !deadline.After(upper)
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
	pending := make([]any, 0, len(i.PendingActions))
	for _, action := range i.PendingActions {
		pending = append(pending, map[string]any{"type": action.Type, "at": action.At})
	}
	return map[string]any{
		"id": i.ID, "status": i.Status, "title": asAny(i.Title),
		"urgency": asAny(i.Urgency), "serviceId": asAny(i.ServiceID),
		"assignedUserIds": users, "pendingActions": pending,
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
			Description: "Evaluate PagerDuty event type, assignment, finite activation, filters, and event/receipt/action time windows without an LLM.",
			Required:    []string{"eventType", "occurredAt", "receivedAt", "evaluatedAt", "incident", "pagerDutyUserId", "snoozeSeconds", "timeZone", "workingHours"},
			Optional:    []string{"serviceIds", "urgencies", "actionableEventTypes", "windowMode", "activeFrom", "activeUntil"},
			Fields: []Field{
				{Name: "eventType", Type: "string", Required: true},
				{Name: "occurredAt", Type: "string", Required: true},
				{Name: "receivedAt", Type: "string", Required: true},
				{Name: "evaluatedAt", Type: "string", Required: true},
				{Name: "incident", Type: "object", Required: true},
				{Name: "pagerDutyUserId", Type: "string", Required: true},
				{Name: "snoozeSeconds", Type: "number", Required: true},
				{Name: "timeZone", Type: "string", Required: true},
				{Name: "workingHours", Type: "array", Required: true},
				{Name: "serviceIds", Type: "array"},
				{Name: "urgencies", Type: "array"},
				{Name: "actionableEventTypes", Type: "array"},
				{Name: "windowMode", Type: "string"},
				{Name: "activeFrom", Type: "string"},
				{Name: "activeUntil", Type: "string"},
			},
			InputExample: map[string]any{
				"eventType":       "{{context.on_pagerduty.output.event.eventType}}",
				"occurredAt":      "{{context.on_pagerduty.output.event.occurredAt}}",
				"receivedAt":      "{{context.on_pagerduty.output.event.receivedAt}}",
				"evaluatedAt":     "{{context.action_clock.output.result.at}}",
				"incident":        "{{context.load_incident.output.result.incident}}",
				"pagerDutyUserId": "PAGERDUTY_USER_ID",
				"snoozeSeconds":   43_200,
				"timeZone":        "UTC",
				"workingHours":    []any{map[string]any{"days": []any{1.0, 2.0, 3.0, 4.0, 5.0}, "start": "09:00", "end": "17:00"}},
			},
			WriteSide: false,
			Execute:   executePagerDutyPolicyEvaluate,
		},
		{
			Name:        "pagerduty.outcome.verify",
			Description: "Verify an authoritative PagerDuty re-read is the same acknowledged incident and retains the exact snooze deadline returned by the write receipt.",
			Required:    []string{"incident", "expectedIncidentId", "expectedSnoozeUntil"},
			Fields: []Field{
				{Name: "incident", Type: "object", Required: true},
				{Name: "expectedIncidentId", Type: "string", Required: true},
				{Name: "expectedSnoozeUntil", Type: "string", Required: true},
			},
			InputExample: map[string]any{
				"incident":            "{{context.verify_incident.output.result.incident}}",
				"expectedIncidentId":  "{{context.snooze_incident.output.result.incident.id}}",
				"expectedSnoozeUntil": "{{context.snooze_incident.output.result.snoozeUntil}}",
			},
			WriteSide: false,
			Execute:   executePagerDutyOutcomeVerify,
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

// executePagerDutyOutcomeVerify joins the immutable snooze write receipt with
// a later authoritative incident read. A status-only check is insufficient:
// acknowledged incidents may have no snooze at all. The pending
// unacknowledge timestamp proves the provider retained the same snooze.
func executePagerDutyOutcomeVerify(_ context.Context, input map[string]any) (map[string]any, error) {
	started := time.Now()
	answer := func(verified, acknowledged, snoozed bool, reason, observed string) (map[string]any, error) {
		return map[string]any{
			"ok": true, "verified": verified, "acknowledged": acknowledged,
			"snoozeVerified": snoozed, "reason": reason,
			"observedSnoozeUntil": observed,
			"latencyMs":           int(time.Since(started).Milliseconds()),
		}, nil
	}
	record, _ := input["incident"].(map[string]any)
	expectedIncidentID, _ := input["expectedIncidentId"].(string)
	expectedIncidentID = strings.TrimSpace(expectedIncidentID)
	expectedRaw, _ := input["expectedSnoozeUntil"].(string)
	expected, expectedErr := time.Parse(time.RFC3339, strings.TrimSpace(expectedRaw))
	incident := parseProjectedPagerDutyIncident(record)
	if incident == nil || expectedIncidentID == "" || len(expectedIncidentID) > pagerDutyIdentifierMaxBytes || expectedErr != nil {
		return answer(false, false, false, "invalid_runtime_input", "")
	}
	if incident.ID != expectedIncidentID {
		return answer(false, incident.Status == "acknowledged", false, "incident_mismatch", "")
	}
	acknowledged := incident.Status == "acknowledged"
	observedRaw, hasObserved := pagerDutyUnacknowledgeAt(incident)
	if !acknowledged {
		return answer(false, false, false, "status_not_acknowledged", observedRaw)
	}
	if !hasObserved {
		return answer(false, true, false, "snooze_missing", "")
	}
	observed, observedErr := time.Parse(time.RFC3339, observedRaw)
	if observedErr != nil || !observed.Equal(expected) {
		return answer(false, true, false, "snooze_deadline_mismatch", observedRaw)
	}
	return answer(true, true, true, "matched", observedRaw)
}

// executePagerDutyPolicyEvaluate is the pure decision ladder — exact
// reason order from the contract. Malformed runtime input answers
// {shouldAct:false, reason:"invalid_runtime_input"}; it never errors.
func executePagerDutyPolicyEvaluate(_ context.Context, input map[string]any) (map[string]any, error) {
	start := time.Now()
	latency := func() int { return int(time.Since(start).Milliseconds()) }
	answer := func(shouldAct bool, reason string, eventOutside, receivedOutside, evaluationOutside bool) (map[string]any, error) {
		return map[string]any{
			"ok": true, "shouldAct": shouldAct, "reason": reason,
			"eventOutsideWorkingHours":      eventOutside,
			"receivedOutsideWorkingHours":   receivedOutside,
			"evaluationOutsideWorkingHours": evaluationOutside,
			"latencyMs":                     latency(),
		}, nil
	}
	eventType, _ := input["eventType"].(string)
	pagerDutyUserID, _ := input["pagerDutyUserId"].(string)
	snoozeSeconds, snoozeSecondsOK := input["snoozeSeconds"].(float64)
	timeZone, _ := input["timeZone"].(string)
	windowMode := "outside"
	windowModeValid := true
	if rawWindowMode, present := input["windowMode"]; present {
		windowMode, windowModeValid = rawWindowMode.(string)
		windowModeValid = windowModeValid && windowMode != ""
	}
	if !windowModeValid {
		windowMode = ""
	}
	occurredAtRaw, _ := input["occurredAt"].(string)
	receivedAtRaw, _ := input["receivedAt"].(string)
	evaluatedAtRaw, evaluatedAtValid := input["evaluatedAt"].(string)
	evaluatedAtValid = evaluatedAtValid && strings.TrimSpace(evaluatedAtRaw) != ""
	incidentRaw, _ := input["incident"].(map[string]any)
	occurredAt, occurredErr := time.Parse(time.RFC3339, occurredAtRaw)
	receivedAt, receivedErr := time.Parse(time.RFC3339, receivedAtRaw)
	evaluatedAt, evaluatedErr := time.Parse(time.RFC3339, evaluatedAtRaw)
	var incident *pagerDutyIncident
	if incidentRaw != nil {
		incident = parseProjectedPagerDutyIncident(incidentRaw)
	}
	activeFrom, activeUntil, activeConfigured, activeValid := pagerDutyActivePeriod(input)
	actionableTypes, actionableValid := pagerDutyOptionalStringList(input, "actionableEventTypes", func(value string) bool {
		return pagerDutyActionableDefaults[value]
	})
	serviceIDs, serviceIDsValid := pagerDutyOptionalStringList(input, "serviceIds", nil)
	urgencies, urgenciesValid := pagerDutyOptionalStringList(input, "urgencies", func(value string) bool {
		return value == "high" || value == "low"
	})
	if incident == nil || occurredErr != nil || receivedErr != nil || evaluatedErr != nil || !evaluatedAtValid ||
		receivedAt.Before(occurredAt) || evaluatedAt.Before(receivedAt) ||
		!snoozeSecondsOK || snoozeSeconds != math.Trunc(snoozeSeconds) ||
		snoozeSeconds < pagerDutySnoozeMinSeconds || snoozeSeconds > pagerDutySnoozeMaxSeconds ||
		(windowMode != "outside" && windowMode != "inside") || !activeValid ||
		!actionableValid || !serviceIDsValid || !urgenciesValid ||
		!validPagerDutyWindowPolicy(timeZone, input["workingHours"]) {
		return answer(false, "invalid_runtime_input", false, false, false)
	}

	actionable := pagerDutyActionableDefaults
	if _, present := input["actionableEventTypes"]; present {
		actionable = map[string]bool{}
		for _, eventType := range actionableTypes {
			actionable[eventType] = true
		}
	}
	windows := parseWorkingWindows(input["workingHours"])

	eventOutside := !IsWithinPagerDutyWorkingHours(occurredAt, timeZone, windows)
	receivedOutside := !IsWithinPagerDutyWorkingHours(receivedAt, timeZone, windows)
	evaluationOutside := !IsWithinPagerDutyWorkingHours(evaluatedAt, timeZone, windows)
	eventWindowMatch := eventOutside
	receivedWindowMatch := receivedOutside
	evaluationWindowMatch := evaluationOutside
	if windowMode == "inside" {
		eventWindowMatch = !eventOutside
		receivedWindowMatch = !receivedOutside
		evaluationWindowMatch = !evaluationOutside
	}
	reason := "matched"
	switch {
	case !actionable[eventType]:
		reason = "event_not_actionable"
	case incident.Status == "resolved":
		reason = "incident_resolved"
	case incident.Status == "acknowledged":
		reason = "incident_already_acknowledged"
	case !containsString(incident.AssignedUserIDs, pagerDutyUserID):
		reason = "user_not_assigned"
	case len(serviceIDs) > 0 && (incident.ServiceID == nil || !containsString(serviceIDs, *incident.ServiceID)):
		reason = "service_filtered"
	case len(urgencies) > 0 && (incident.Urgency == nil || !containsString(urgencies, *incident.Urgency)):
		reason = "urgency_filtered"
	case activeConfigured && (occurredAt.Before(activeFrom) || !occurredAt.Before(activeUntil) ||
		receivedAt.Before(activeFrom) || !receivedAt.Before(activeUntil) ||
		evaluatedAt.Before(activeFrom) || !evaluatedAt.Before(activeUntil)):
		reason = "outside_active_period"
	case !eventWindowMatch && windowMode == "inside":
		reason = "event_outside_allowed_window"
	case !receivedWindowMatch && windowMode == "inside":
		reason = "received_outside_allowed_window"
	case !evaluationWindowMatch && windowMode == "inside":
		reason = "evaluation_outside_allowed_window"
	case !eventWindowMatch:
		reason = "event_in_working_hours"
	case !receivedWindowMatch:
		reason = "received_in_working_hours"
	case !evaluationWindowMatch:
		reason = "evaluation_in_working_hours"
	}
	return answer(reason == "matched", reason, eventOutside, receivedOutside, evaluationOutside)
}

func pagerDutyActivePeriod(input map[string]any) (from, until time.Time, configured, valid bool) {
	rawFrom, fromPresent := input["activeFrom"]
	rawUntil, untilPresent := input["activeUntil"]
	if !fromPresent && !untilPresent {
		return time.Time{}, time.Time{}, false, true
	}
	fromRaw, fromValid := rawFrom.(string)
	untilRaw, untilValid := rawUntil.(string)
	fromRaw, untilRaw = strings.TrimSpace(fromRaw), strings.TrimSpace(untilRaw)
	if !fromPresent || !untilPresent || !fromValid || !untilValid || fromRaw == "" || untilRaw == "" {
		return time.Time{}, time.Time{}, true, false
	}
	from, fromErr := time.Parse(time.RFC3339, fromRaw)
	until, untilErr := time.Parse(time.RFC3339, untilRaw)
	if fromErr != nil || untilErr != nil || !until.After(from) || !pagerDutyPeriodWithinMax(from, until, input["timeZone"]) {
		return time.Time{}, time.Time{}, true, false
	}
	return from, until, true, true
}

func pagerDutyPeriodWithinMax(from, until time.Time, rawTimeZone any) bool {
	timeZone, _ := rawTimeZone.(string)
	timeZone = strings.TrimSpace(timeZone)
	if timeZone == "" {
		return false
	}
	location, err := time.LoadLocation(timeZone)
	if err != nil {
		return false
	}
	localFrom := from.In(location)
	localUntil := until.In(location)
	return !localUntil.After(localFrom.AddDate(0, 0, 31))
}

func containsString(haystack []string, needle string) bool {
	return slices.Contains(haystack, needle)
}

func pagerDutyOptionalStringList(input map[string]any, key string, allowed func(string) bool) ([]string, bool) {
	raw, present := input[key]
	if !present {
		return nil, true
	}
	if raw == nil {
		return nil, false
	}
	items, ok := raw.([]any)
	if !ok || len(items) > 100 {
		return nil, false
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		value, ok := item.(string)
		value = strings.TrimSpace(value)
		if !ok || value == "" || len(value) > 300 || (allowed != nil && !allowed(value)) {
			return nil, false
		}
		out = append(out, value)
	}
	return out, true
}

// validPagerDutyWindowPolicy validates the predicate before either direct or
// inverted use. A parse failure is neither "inside" nor "outside" and must
// therefore stop both window modes before an external effect can run.
func validPagerDutyWindowPolicy(timeZone string, raw any) bool {
	if _, err := time.LoadLocation(timeZone); err != nil {
		return false
	}
	items, ok := raw.([]any)
	if !ok || len(items) == 0 || len(items) > pagerDutyWorkingWindowsMax {
		return false
	}
	for _, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			return false
		}
		rawDays, ok := entry["days"].([]any)
		if !ok || len(rawDays) == 0 || len(rawDays) > 7 {
			return false
		}
		seenDays := map[int]bool{}
		for _, rawDay := range rawDays {
			day, ok := rawDay.(float64)
			if !ok || day != math.Trunc(day) || day < 0 || day > 6 {
				return false
			}
			integerDay := int(day)
			if seenDays[integerDay] {
				return false
			}
			seenDays[integerDay] = true
		}
		start, startOK := entry["start"].(string)
		end, endOK := entry["end"].(string)
		startMinute, validStart := zonedwindow.ParseLocalMinute(start)
		endMinute, validEnd := zonedwindow.ParseLocalMinute(end)
		if !startOK || !endOK || !validStart || !validEnd || startMinute == endMinute {
			return false
		}
	}
	return true
}

// parseWorkingWindows converts the already-validated wire shape. It remains
// defensive because this helper is package-visible to tests and future call
// sites, but executePagerDutyPolicyEvaluate never reaches it with bad input.
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
		daysValid := false
		if rawDays, ok := entry["days"].([]any); ok && len(rawDays) > 0 && len(rawDays) <= 7 {
			daysValid = true
			seenDays := map[int]bool{}
			for _, rawDay := range rawDays {
				if day, ok := rawDay.(float64); ok && day == math.Trunc(day) && day >= 0 && day <= 6 {
					integerDay := int(day)
					if seenDays[integerDay] {
						daysValid = false
						continue
					}
					seenDays[integerDay] = true
					window.Days = append(window.Days, integerDay)
				} else {
					daysValid = false
				}
			}
		}
		if !daysValid {
			// Preserve one absorbing invalid window instead of silently
			// accepting a valid subset of malformed day entries.
			window.Days = nil
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
	requesterEmail = strings.TrimSpace(requesterEmail)
	incidentID, _ := input["incidentId"].(string)
	region, _ := input["region"].(string)
	if region == "" {
		region = "us"
	}
	if credential == "" || !validPagerDutyRequesterEmail(requesterEmail) ||
		incidentID == "" || len(incidentID) > pagerDutyIdentifierMaxBytes || (region != "us" && region != "eu") {
		return envelopeError(name+" requires credential, requesterEmail, and incidentId", latency())
	}
	var snoozeDuration int
	if name == "pagerduty.incident.snooze" {
		duration, ok := input["durationSeconds"].(float64)
		if !ok || duration != math.Trunc(duration) ||
			duration < pagerDutySnoozeMinSeconds || duration > pagerDutySnoozeMaxSeconds {
			return envelopeError("pagerduty.incident.snooze requires durationSeconds in 60..604800", latency())
		}
		snoozeDuration = int(duration)
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
	if rawOverride, present := input["rateLimitPerMin"]; present {
		override, ok := rawOverride.(float64)
		if !ok || override != math.Trunc(override) || override < 1 || override > 10_000 {
			return envelopeError(name+" requires an integer rateLimitPerMin in 1..10000", latency())
		}
		// Workflow configuration may reduce provider pressure for one flow, but
		// it can never raise the tenant ceiling resolved from org configuration.
		rateLimit = min(rateLimit, int(override))
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
		method, path = "PUT", "/incidents"
		body, _ = json.Marshal(map[string]any{"incidents": []map[string]any{{
			"id": incidentID, "type": "incident_reference", "status": "acknowledged",
		}}})
	case "pagerduty.incident.snooze":
		method, path = "POST", path+"/snooze"
		body, _ = json.Marshal(map[string]any{"duration": snoozeDuration})
	}

	statusCode, responseBody, fetchError := deps.Fetch(ctx,
		method, pagerDutyAPIBase(region)+path, pagerDutyHeaders(token, requesterEmail), body,
		pagerDutyResponseMaxBytes)
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
	if ok && name == "pagerduty.incident.acknowledge" {
		incident := parsePagerDutyIncidentListBody(responseBody, incidentID)
		ok = incident != nil && incident.Status == "acknowledged"
		if ok {
			record(true, statusCode, "")
			return map[string]any{
				"ok": true, "incident": incident.toMap(),
				"statusCode": statusCode, "latencyMs": latency(),
			}
		}
	}
	if ok && name == "pagerduty.incident.snooze" {
		incident := parsePagerDutyIncidentBody(responseBody)
		snoozeUntil, hasSnooze := pagerDutyUnacknowledgeAt(incident)
		ok = incident != nil && incident.ID == incidentID && incident.Status == "acknowledged" && hasSnooze &&
			pagerDutySnoozeReceiptMatches(snoozeUntil, start, time.Now(), snoozeDuration)
		if ok {
			record(true, statusCode, "")
			return map[string]any{
				"ok": true, "incident": incident.toMap(), "snoozeUntil": snoozeUntil,
				"statusCode": statusCode, "latencyMs": latency(),
			}
		}
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

func validPagerDutyRequesterEmail(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 254 || strings.ContainsAny(value, " <>\t\r\n") {
		return false
	}
	for _, character := range value {
		if character < 0x21 || character == 0x7f {
			return false
		}
	}
	separator := strings.LastIndexByte(value, '@')
	return separator > 0 && separator < len(value)-1 &&
		strings.Count(value, "@") == 1 && strings.Contains(value[separator+1:], ".")
}
