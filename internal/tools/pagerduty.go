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
	if assignments, ok := arrayItems(record["assignments"]); ok {
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
	rawUsers, hasUsers := arrayItems(record["assignedUserIds"])
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
	items, ok := arrayItems(raw)
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

func validatePagerDutyAPIInput(input map[string]any, options InputValidationOptions) error {
	for _, field := range []string{"credential", "incidentId"} {
		raw, present := input[field]
		if !present || isDeferredWholeTemplate(raw, options) {
			continue
		}
		value, _ := raw.(string)
		if strings.TrimSpace(value) == "" || len(value) > pagerDutyIdentifierMaxBytes || strings.TrimSpace(value) != value {
			return fmt.Errorf("%s must be a canonical non-empty identifier of at most %d bytes", field, pagerDutyIdentifierMaxBytes)
		}
	}
	if raw, present := input["requesterEmail"]; present && !isDeferredWholeTemplate(raw, options) {
		value, _ := raw.(string)
		if !validPagerDutyRequesterEmail(value) || strings.TrimSpace(value) != value {
			return fmt.Errorf("requesterEmail must be a valid single-line email address")
		}
	}
	if raw, present := input["region"]; present && !isDeferredWholeTemplate(raw, options) {
		value, _ := raw.(string)
		if value != "us" && value != "eu" {
			return fmt.Errorf("region must be us or eu")
		}
	}
	if raw, present := input["rateLimitPerMin"]; present && !isDeferredWholeTemplate(raw, options) {
		if _, ok := boundedWholeNumber(raw, 1, 10_000); !ok {
			return fmt.Errorf("rateLimitPerMin must be an integer between 1 and 10000")
		}
	}
	return nil
}

func validatePagerDutySnoozeInput(input map[string]any, options InputValidationOptions) error {
	if err := validatePagerDutyAPIInput(input, options); err != nil {
		return err
	}
	if raw, present := input["durationSeconds"]; present && !isDeferredWholeTemplate(raw, options) {
		if _, ok := boundedWholeNumber(raw, pagerDutySnoozeMinSeconds, pagerDutySnoozeMaxSeconds); !ok {
			return fmt.Errorf("durationSeconds must be an integer between %d and %d", pagerDutySnoozeMinSeconds, pagerDutySnoozeMaxSeconds)
		}
	}
	return nil
}

func validatePagerDutyStringList(raw any, options InputValidationOptions, allowed func(string) bool) bool {
	if isDeferredWholeTemplate(raw, options) {
		return true
	}
	items, ok := arrayItems(raw)
	if !ok || len(items) > 100 {
		return false
	}
	seen := map[string]bool{}
	for _, item := range items {
		if isDeferredWholeTemplate(item, options) {
			continue
		}
		value, ok := item.(string)
		if !ok || value == "" || value != strings.TrimSpace(value) || len(value) > pagerDutyIdentifierMaxBytes ||
			seen[value] || allowed != nil && !allowed(value) {
			return false
		}
		seen[value] = true
	}
	return true
}

func validatePagerDutyWindows(raw any, options InputValidationOptions) bool {
	if isDeferredWholeTemplate(raw, options) {
		return true
	}
	items, ok := arrayItems(raw)
	if !ok || len(items) == 0 || len(items) > pagerDutyWorkingWindowsMax {
		return false
	}
	for _, item := range items {
		entry, ok := item.(map[string]any)
		if !ok || entry == nil {
			return false
		}
		rawDays, present := entry["days"]
		if !present {
			return false
		}
		if !isDeferredWholeTemplate(rawDays, options) {
			days, ok := arrayItems(rawDays)
			if !ok || len(days) == 0 || len(days) > 7 {
				return false
			}
			seen := map[int64]bool{}
			for _, rawDay := range days {
				if isDeferredWholeTemplate(rawDay, options) {
					continue
				}
				day, ok := boundedWholeNumber(rawDay, 0, 6)
				if !ok || seen[day] {
					return false
				}
				seen[day] = true
			}
		}
		startRaw, startPresent := entry["start"]
		endRaw, endPresent := entry["end"]
		if !startPresent || !endPresent {
			return false
		}
		startDeferred := isDeferredWholeTemplate(startRaw, options)
		endDeferred := isDeferredWholeTemplate(endRaw, options)
		start, startOK := startRaw.(string)
		end, endOK := endRaw.(string)
		if !startDeferred {
			_, startOK = zonedwindow.ParseLocalMinute(start)
		}
		if !endDeferred {
			_, endOK = zonedwindow.ParseLocalMinute(end)
		}
		if !startOK || !endOK {
			return false
		}
		if !startDeferred && !endDeferred {
			startMinute, _ := zonedwindow.ParseLocalMinute(start)
			endMinute, _ := zonedwindow.ParseLocalMinute(end)
			if startMinute == endMinute {
				return false
			}
		}
	}
	return true
}

// validatePagerDutyPolicyDefinition validates literal policy authored into a
// workflow. Rendered dynamic provider evidence still reaches the deterministic
// evaluator, whose structured invalid_runtime_input outcome is part of the
// recovery contract rather than a thrown registry error.
func validatePagerDutyPolicyDefinition(input map[string]any, options InputValidationOptions) error {
	if !options.AllowWholeTemplates {
		return nil
	}
	if raw, present := input["eventType"]; present && !isDeferredWholeTemplate(raw, options) {
		value, _ := raw.(string)
		if value == "" || value != strings.TrimSpace(value) || len(value) > pagerDutyIdentifierMaxBytes {
			return fmt.Errorf("eventType must be a canonical non-empty identifier")
		}
	}
	if raw, present := input["pagerDutyUserId"]; present && !isDeferredWholeTemplate(raw, options) {
		value, _ := raw.(string)
		if value == "" || value != strings.TrimSpace(value) || len(value) > pagerDutyIdentifierMaxBytes {
			return fmt.Errorf("pagerDutyUserId must be a canonical non-empty identifier")
		}
	}
	if raw, present := input["snoozeSeconds"]; present && !isDeferredWholeTemplate(raw, options) {
		if _, ok := boundedWholeNumber(raw, pagerDutySnoozeMinSeconds, pagerDutySnoozeMaxSeconds); !ok {
			return fmt.Errorf("snoozeSeconds must be an integer between %d and %d", pagerDutySnoozeMinSeconds, pagerDutySnoozeMaxSeconds)
		}
	}
	timeZone := ""
	timeZoneConcrete := false
	if raw, present := input["timeZone"]; present && !isDeferredWholeTemplate(raw, options) {
		timeZone, _ = raw.(string)
		if timeZone == "" || timeZone != strings.TrimSpace(timeZone) {
			return fmt.Errorf("timeZone must be a canonical IANA time zone")
		}
		if _, err := time.LoadLocation(timeZone); err != nil {
			return fmt.Errorf("timeZone must be a valid IANA time zone")
		}
		timeZoneConcrete = true
	}
	if raw, present := input["workingHours"]; present && !validatePagerDutyWindows(raw, options) {
		return fmt.Errorf("workingHours must contain 1..%d valid, unambiguous local windows", pagerDutyWorkingWindowsMax)
	}
	if raw, present := input["windowMode"]; present && !isDeferredWholeTemplate(raw, options) {
		value, _ := raw.(string)
		if value != "outside" && value != "inside" {
			return fmt.Errorf("windowMode must be outside or inside")
		}
	}
	for _, spec := range []struct {
		field   string
		allowed func(string) bool
	}{
		{field: "serviceIds"},
		{field: "urgencies", allowed: func(value string) bool { return value == "high" || value == "low" }},
		{field: "actionableEventTypes", allowed: func(value string) bool { return pagerDutyActionableDefaults[value] }},
	} {
		if raw, present := input[spec.field]; present && !validatePagerDutyStringList(raw, options, spec.allowed) {
			return fmt.Errorf("%s must be a bounded list of unique supported identifiers", spec.field)
		}
	}

	parsedTimes := map[string]time.Time{}
	for _, field := range []string{"occurredAt", "receivedAt", "evaluatedAt"} {
		raw, present := input[field]
		if !present || isDeferredWholeTemplate(raw, options) {
			continue
		}
		value, _ := raw.(string)
		parsed, err := time.Parse(time.RFC3339, value)
		if err != nil {
			return fmt.Errorf("%s must be RFC3339", field)
		}
		parsedTimes[field] = parsed
	}
	if occurred, ok := parsedTimes["occurredAt"]; ok {
		if received, ok := parsedTimes["receivedAt"]; ok && received.Before(occurred) {
			return fmt.Errorf("receivedAt must not precede occurredAt")
		}
	}
	if received, ok := parsedTimes["receivedAt"]; ok {
		if evaluated, ok := parsedTimes["evaluatedAt"]; ok && evaluated.Before(received) {
			return fmt.Errorf("evaluatedAt must not precede receivedAt")
		}
	}

	fromRaw, fromPresent := input["activeFrom"]
	untilRaw, untilPresent := input["activeUntil"]
	if options.RequireAll && fromPresent != untilPresent {
		return fmt.Errorf("activeFrom and activeUntil must be supplied together")
	}
	if fromPresent && untilPresent && !isDeferredWholeTemplate(fromRaw, options) && !isDeferredWholeTemplate(untilRaw, options) {
		fromText, _ := fromRaw.(string)
		untilText, _ := untilRaw.(string)
		from, fromErr := time.Parse(time.RFC3339, fromText)
		until, untilErr := time.Parse(time.RFC3339, untilText)
		if fromErr != nil || untilErr != nil || !until.After(from) {
			return fmt.Errorf("activeFrom and activeUntil must form an increasing RFC3339 interval")
		}
		if timeZoneConcrete && !pagerDutyPeriodWithinMax(from, until, timeZone) {
			return fmt.Errorf("active period must not exceed 31 local calendar days")
		}
	}
	if raw, present := input["incident"]; present && !isDeferredWholeTemplate(raw, options) {
		record, _ := raw.(map[string]any)
		if parseProjectedPagerDutyIncident(record) == nil {
			return fmt.Errorf("incident must match the bounded authoritative PagerDuty projection")
		}
	}
	return nil
}

func validatePagerDutyOutcomeDefinition(input map[string]any, options InputValidationOptions) error {
	if !options.AllowWholeTemplates {
		return nil
	}
	if raw, present := input["expectedIncidentId"]; present && !isDeferredWholeTemplate(raw, options) {
		value, _ := raw.(string)
		if value == "" || value != strings.TrimSpace(value) || len(value) > pagerDutyIdentifierMaxBytes {
			return fmt.Errorf("expectedIncidentId must be a canonical non-empty identifier")
		}
	}
	if raw, present := input["expectedSnoozeUntil"]; present && !isDeferredWholeTemplate(raw, options) {
		value, _ := raw.(string)
		if _, err := time.Parse(time.RFC3339, value); err != nil {
			return fmt.Errorf("expectedSnoozeUntil must be RFC3339")
		}
	}
	if raw, present := input["incident"]; present && !isDeferredWholeTemplate(raw, options) {
		record, _ := raw.(map[string]any)
		if parseProjectedPagerDutyIncident(record) == nil {
			return fmt.Errorf("incident must match the bounded authoritative PagerDuty projection")
		}
	}
	return nil
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
			Validate:     validatePagerDutyAPIInput,
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
			Validate:  validatePagerDutyPolicyDefinition,
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
			Validate:  validatePagerDutyOutcomeDefinition,
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
			Validate:     validatePagerDutyAPIInput,
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
			Validate:  validatePagerDutySnoozeInput,
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
	_, snoozeSecondsOK := boundedWholeNumber(input["snoozeSeconds"], pagerDutySnoozeMinSeconds, pagerDutySnoozeMaxSeconds)
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
		!snoozeSecondsOK ||
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
	items, ok := arrayItems(raw)
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
	items, ok := arrayItems(raw)
	if !ok || len(items) == 0 || len(items) > pagerDutyWorkingWindowsMax {
		return false
	}
	for _, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			return false
		}
		rawDays, ok := arrayItems(entry["days"])
		if !ok || len(rawDays) == 0 || len(rawDays) > 7 {
			return false
		}
		seenDays := map[int]bool{}
		for _, rawDay := range rawDays {
			day, ok := boundedWholeNumber(rawDay, 0, 6)
			if !ok {
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
	items, ok := arrayItems(raw)
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
		if rawDays, ok := arrayItems(entry["days"]); ok && len(rawDays) > 0 && len(rawDays) <= 7 {
			daysValid = true
			seenDays := map[int]bool{}
			for _, rawDay := range rawDays {
				if day, ok := boundedWholeNumber(rawDay, 0, 6); ok {
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

// executePagerDutyAPICall runs the three credentialed incident operations
// through the shared provider seam: the request differs per operation, and
// so does the receipt that proves it — a read must return the same incident,
// an acknowledge must come back acknowledged, and a snooze must carry the
// exact pending unacknowledge deadline the duration implies.
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
		duration, ok := boundedWholeNumber(input["durationSeconds"], pagerDutySnoozeMinSeconds, pagerDutySnoozeMaxSeconds)
		if !ok {
			return envelopeError("pagerduty.incident.snooze requires durationSeconds in 60..604800", latency())
		}
		snoozeDuration = int(duration)
	}
	verb := "acknowledge"
	switch name {
	case "pagerduty.incident.get":
		verb = "incident read"
	case "pagerduty.incident.snooze":
		verb = "snooze"
	}
	failure := func(statusCode int, _ string) string {
		if statusCode > 0 {
			return fmt.Sprintf("pagerduty %s failed (%d)", verb, statusCode)
		}
		return "pagerduty " + verb + " failed"
	}
	rateLimitOverride, hasRateLimitOverride := input["rateLimitPerMin"]
	call := providerCall{
		tool: name, credentialKind: "pagerduty_api_token", credential: credential,
		rateLimitFamily: "pagerduty", rateLimitDefault: pagerDutyDefaultRateLimitMin,
		rateLimitOverride: rateLimitOverride, hasRateLimitOverride: hasRateLimitOverride,
		responseMaxBytes: pagerDutyResponseMaxBytes,
		request: func(token string) (string, string, map[string]string, []byte, string) {
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
			return method, pagerDutyAPIBase(region) + path, pagerDutyHeaders(token, requesterEmail), body, ""
		},
		receipt: func(statusCode int, responseBody string, startedAt time.Time) (map[string]any, string) {
			switch name {
			case "pagerduty.incident.get":
				incident := parsePagerDutyIncidentBody(responseBody)
				if incident == nil || incident.ID != incidentID {
					return nil, failure(statusCode, "")
				}
				return map[string]any{"incident": incident.toMap()}, ""
			case "pagerduty.incident.acknowledge":
				incident := parsePagerDutyIncidentListBody(responseBody, incidentID)
				if incident == nil || incident.Status != "acknowledged" {
					return nil, failure(statusCode, "")
				}
				return map[string]any{"incident": incident.toMap()}, ""
			default:
				incident := parsePagerDutyIncidentBody(responseBody)
				snoozeUntil, hasSnooze := pagerDutyUnacknowledgeAt(incident)
				if incident == nil || incident.ID != incidentID || incident.Status != "acknowledged" || !hasSnooze ||
					!pagerDutySnoozeReceiptMatches(snoozeUntil, startedAt, time.Now(), snoozeDuration) {
					return nil, failure(statusCode, "")
				}
				return map[string]any{"incident": incident.toMap(), "snoozeUntil": snoozeUntil}, ""
			}
		},
		failure: failure,
	}
	return call.execute(ctx, deps)
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
