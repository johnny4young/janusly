// Package publishgate is the only path from an agent's draft to production:
// a qualification receipt bound to the draft's digest, then publication.
package publishgate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"maps"
	"reflect"
	"slices"
	"strings"

	"github.com/johnny4young/janusly/internal/authoring"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/recovery"
	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/workflowreadiness"
	"github.com/johnny4young/janusly/internal/workflowvalidation"
)

const (
	maxFixtures         = 20
	maxFixtureStubBytes = 64 << 10
	maxFixturesBytes    = 256 << 10
)

// Fixture is one behaviour example: an input, stand-in outputs for the steps
// it does not want to execute, and what the run must end with.
type Fixture struct {
	Name   string         `json:"name" jsonschema:"unique case name, at most 80 characters"`
	Input  map[string]any `json:"input,omitempty" jsonschema:"run input"`
	Stubs  map[string]any `json:"stubs,omitempty" jsonschema:"stand-in outputs by step id; approvals, forms and routers cannot take one"`
	Expect Expectation    `json:"expect" jsonschema:"how the run must end"`
}

// Expectation is the end state a fixture requires. Output is a subset of the
// run's declared output. "waiting" passes when the run stops at a person.
type Expectation struct {
	Status string         `json:"status" jsonschema:"succeeded, failed or waiting (stopped at a person's step)"`
	Output map[string]any `json:"output,omitempty" jsonschema:"fields the run's declared output must contain"`
}

// Check is one gate result an agent can act on without a person.
type Check struct {
	Code    string `json:"code"`
	Status  string `json:"status"`
	Path    string `json:"path,omitempty"`
	Message string `json:"message"`
	Fix     string `json:"fix,omitempty"`
}

func failed(code, path, message, fix string) Check {
	return Check{Code: code, Status: "failed", Path: path, Message: message, Fix: fix}
}

// Passed reports whether every check passed.
func Passed(checks []Check) bool {
	return !slices.ContainsFunc(checks, func(check Check) bool { return check.Status != "passed" })
}

// Digest binds a receipt to the exact document, fixtures and base version it
// qualified, so a draft re-saved after the base moved is a new draft.
func Digest(baseVersionID string, document []byte, fixtures []Fixture) (string, error) {
	rawFixtures, err := json.Marshal(fixtures)
	if err != nil {
		return "", err
	}
	sum := sha256.New()
	sum.Write([]byte(baseVersionID + "\n"))
	sum.Write(document)
	sum.Write([]byte{'\n'})
	sum.Write(rawFixtures)
	return hex.EncodeToString(sum.Sum(nil)), nil
}

// ParseFixtures validates fixture shape against the workflow it exercises.
func ParseFixtures(raw json.RawMessage, wf *domain.Workflow) ([]Fixture, []Check) {
	fixtures := []Fixture{}
	if len(raw) == 0 || string(raw) == "null" {
		return fixtures, nil
	}
	if len(raw) > maxFixturesBytes {
		return nil, []Check{failed("fixtures_too_large", "/fixtures", "fixtures exceed 256 KiB", "Keep fixture inputs and stubs small.")}
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fixtures); err != nil {
		return nil, []Check{failed("fixtures_invalid", "/fixtures",
			"fixtures must be an array of {name, input, stubs, expect}", "Match the fixture shape in drafts.save's inputSchema.")}
	}
	if len(fixtures) > maxFixtures {
		return nil, []Check{failed("fixtures_too_many", "/fixtures", "at most 20 fixtures", "Keep the cases that matter.")}
	}
	nodeTypes := map[string]string{}
	for _, node := range wf.Nodes {
		nodeTypes[node.ID] = node.Type
	}
	checks := []Check{}
	names := map[string]bool{}
	for index, fixture := range fixtures {
		path := fmt.Sprintf("/fixtures/%d", index)
		name := strings.TrimSpace(fixture.Name)
		if name == "" || len(name) > 80 || names[name] {
			checks = append(checks, failed("fixture_name_invalid", path+"/name", "each fixture needs a unique name of at most 80 characters", "Name the case it covers."))
		}
		names[name] = true
		switch fixture.Expect.Status {
		case "succeeded", "failed", "waiting":
		default:
			checks = append(checks, failed("fixture_expectation_invalid", path+"/expect/status",
				"expect.status must be succeeded, failed or waiting", "Say how the run must end."))
		}
		for _, secretPath := range secretLiteralPaths(map[string]any{"input": fixture.Input, "stubs": fixture.Stubs}, path) {
			checks = append(checks, failed("secret_literal", secretPath, "a fixture value looks like a secret written in clear",
				"Use a made-up value; fixtures are stored with the draft."))
		}
		for _, nodeID := range sortedKeys(fixture.Stubs) {
			stubPath := path + "/stubs/" + nodeID
			kind, ok := nodeTypes[nodeID]
			switch {
			case !ok:
				checks = append(checks, failed("fixture_stub_unknown_step", stubPath, "the stub names a step the workflow does not have", "Stub an existing step id."))
			case !engine.DraftPinAllowed(kind):
				checks = append(checks, failed("fixture_stub_not_allowed", stubPath,
					"approvals, forms and routers cannot be stubbed", "Expect status waiting instead of stubbing a person's step."))
			}
			if raw, err := json.Marshal(fixture.Stubs[nodeID]); err != nil || len(raw) > maxFixtureStubBytes {
				checks = append(checks, failed("fixture_stub_too_large", stubPath, "a stub is at most 64 KiB", "Stub only the fields later steps read."))
			}
		}
	}
	return fixtures, checks
}

// StaticChecks runs every check that needs no execution. catalog binds the
// draft's tools, subworkflows and credentials to what the tenant has.
func StaticChecks(wf *domain.Workflow, document map[string]any, fixtures []Fixture, catalog authoring.Catalog) []Check {
	checks := []Check{}
	for _, issue := range workflowvalidation.Validate(wf).Issues {
		if issue.Code == domain.CodeNodeTypeNotExecutable {
			continue
		}
		checks = append(checks, failed("invalid_"+issue.Code, nodePath(issue.NodeID), issue.Message,
			"Fix the step; catalog.describe section=nodes shows a valid example."))
	}
	readiness := domain.CheckWorkflowReadiness(wf, workflowreadiness.Options())
	for _, issue := range readiness.Issues {
		if issue.Severity == "error" {
			checks = append(checks, failed("not_ready_"+issue.Code, nodePath(issue.NodeID), issue.Message, issue.Suggestion))
		}
	}
	if len(wf.Outputs) == 0 {
		checks = append(checks, failed("intent_missing", "/outputs",
			"the workflow declares no outputs, so nothing says what it promises", "Declare outputs: the fields a successful run returns."))
	}
	effects := EffectNodes(wf)
	if len(effects) > 0 {
		checks = append(checks, recoveryChecks(wf)...)
	}
	for _, node := range wf.Nodes {
		if slices.Contains(effects, node.ID) && node.Config["resultPolicy"] == "envelope" {
			checks = append(checks, failed("result_unchecked", nodePath(node.ID)+"/config/resultPolicy",
				"a write step opts out of checking its result, so a failed send would read as success",
				"Remove resultPolicy or set it to require_ok."))
		}
	}
	required := StubRequired(wf)
	for index, fixture := range fixtures {
		for _, nodeID := range required {
			if _, stubbed := fixture.Stubs[nodeID]; !stubbed {
				checks = append(checks, failed("stub_required", fmt.Sprintf("/fixtures/%d/stubs/%s", index, nodeID),
					"this step reaches outside Janusly or reads a secret, so a fixture may not run it before a person approves the workflow",
					"Stub its output in this fixture."))
			}
		}
	}
	if mentionsSensitive(wf.Outputs) {
		checks = append(checks, failed("secret_in_outputs", "/outputs",
			"a declared output references a secret or the environment, which would put it in the run's output", "Remove the reference from outputs."))
	}
	if len(fixtures) == 0 {
		checks = append(checks, failed("fixtures_missing", "/fixtures",
			"the draft has no behaviour fixtures", "Add at least one fixture with an input and the output it must produce."))
	}
	for _, path := range placeholderPaths(document, "") {
		checks = append(checks, failed("observed_placeholder", path,
			"this value was left open when the draft was made from an observed session",
			"Replace it with the real value; a session shows what ran, not what it was for."))
	}
	for _, path := range secretLiteralPaths(document, "") {
		checks = append(checks, failed("secret_literal", path,
			"a value looks like a secret written in clear", "Reference a credential instead; credentials.request returns a link for a person."))
	}
	bindings, _, _ := authoring.BindWorkflowJSON(catalog, document)
	for _, missing := range bindings.Missing {
		code, fix := "capability_missing", "Use a name catalog.describe lists."
		if missing.Kind == "credential" {
			code, fix = "credential_missing", "Ask a person to create the credential; credentials.request returns the link."
		}
		message := fmt.Sprintf("%s %q is not available in this organization", missing.Kind, missing.Requested)
		if missing.Requested == "" {
			message = fmt.Sprintf("%s is incomplete: %s", missing.Field, missing.Reason)
		}
		if len(missing.Alternatives) > 0 {
			fix += " Closest: " + strings.Join(missing.Alternatives, ", ") + "."
		}
		checks = append(checks, failed(code, nodePath(missing.NodeID)+"/"+strings.ReplaceAll(missing.Field, ".", "/"), message, fix))
	}
	if len(checks) == 0 {
		checks = append(checks, Check{Code: "static", Status: "passed", Message: "structure, readiness, contracts, credentials and literals passed"})
	}
	return checks
}

func recoveryChecks(wf *domain.Workflow) []Check {
	if wf.Recovery == nil || wf.Recovery.Contract == nil || wf.Recovery.Contract.Version != "2" {
		return []Check{failed("recovery_contract_missing", "/recovery/contract",
			"the workflow writes but has no Recovery Contract v2", "Declare a recovery contract with detectors and evaluation fixtures.")}
	}
	outcomes := recovery.FixtureOutcomesForValidation(wf.Recovery.Contract)
	if len(outcomes) == 0 {
		return []Check{failed("recovery_fixtures_missing", "/recovery/contract/failure/semantic/evaluationFixtures",
			"the recovery contract has no evaluation fixtures", "Add a pass and a violation fixture for each detector.")}
	}
	checks := []Check{}
	for _, outcome := range outcomes {
		if !outcome.Passed {
			checks = append(checks, failed("recovery_fixture_failed", "/recovery/contract/failure/semantic/evaluationFixtures",
				fmt.Sprintf("recovery fixture %s expected %s", outcome.ID, outcome.Expected), "Fix the detector or the fixture."))
		}
	}
	return checks
}

// EffectNodes are the steps that may change something outside Janusly.
func EffectNodes(wf *domain.Workflow) []string {
	ids := []string{}
	for _, node := range wf.Nodes {
		if engine.NodeMayHaveEffect(node) {
			ids = append(ids, node.ID)
		}
	}
	return ids
}

func nodePath(nodeID string) string {
	if nodeID == "" {
		return ""
	}
	return "/nodes/" + nodeID
}

// ObservedPlaceholderPrefix marks a value a draft made from an observed
// session leaves for a person or agent to fill in.
const ObservedPlaceholderPrefix = "observed_placeholder:"

// placeholderPaths names every open placeholder; steps are addressed by id.
func placeholderPaths(value any, path string) []string {
	switch typed := value.(type) {
	case string:
		if strings.HasPrefix(typed, ObservedPlaceholderPrefix) {
			return []string{path}
		}
	case []any:
		paths := []string{}
		for index, item := range typed {
			segment := fmt.Sprint(index)
			if node, ok := item.(map[string]any); ok && path == "/nodes" {
				if id, ok := node["id"].(string); ok && id != "" {
					segment = id
				}
			}
			paths = append(paths, placeholderPaths(item, path+"/"+segment)...)
		}
		return paths
	case map[string]any:
		paths := []string{}
		for _, key := range sortedKeys(typed) {
			paths = append(paths, placeholderPaths(typed[key], path+"/"+key)...)
		}
		return paths
	}
	return nil
}

func secretLiteralPaths(value any, path string) []string {
	switch typed := value.(type) {
	case string:
		if signature.ScrubSecretShapes(typed) != typed {
			return []string{path}
		}
	case []any:
		paths := []string{}
		for index, item := range typed {
			paths = append(paths, secretLiteralPaths(item, fmt.Sprintf("%s/%d", path, index))...)
		}
		return paths
	case map[string]any:
		paths := []string{}
		for _, key := range sortedKeys(typed) {
			paths = append(paths, secretLiteralPaths(typed[key], path+"/"+key)...)
		}
		return paths
	}
	return nil
}

func sortedKeys[V any](values map[string]V) []string {
	return slices.Sorted(maps.Keys(values))
}

// Step classes for the gate. Logic and person steps reach nothing outside the
// run; pure tools only transform their input. Anything else, or any step that
// mentions a secret or the environment, reaches outside Janusly.
var (
	logicTypes = map[string]bool{
		"transform": true, "condition": true, "noop": true, "router": true,
		"parallel_fork": true, "join": true, "wait_until": true,
	}
	personTypes  = map[string]bool{"approval": true, "human_form": true}
	triggerTypes = map[string]bool{
		"schedule": true, "webhook": true, "webhook_received": true, "email_received": true,
		"file_dropped": true, "pagerduty_incident": true, "mcp_server_event": true,
	}
	pureTools = map[string]bool{
		"text.uppercase": true, "json.parse": true, "json.pick": true, "json.set": true, "json.merge": true,
		"csv.parse": true, "csv.filter": true, "csv.stringify": true, "time.now": true, "time.window": true,
	}
)

// mentionsSensitive is a deliberately broad text check: any secret or
// environment reference, in any spelling the renderer might accept.
func mentionsSensitive(value any) bool {
	raw, _ := json.Marshal(value)
	text := strings.ToLower(string(raw))
	return strings.Contains(text, "secret") || strings.Contains(text, "env.")
}

func pureStep(node domain.Node) bool {
	if mentionsSensitive(node.Config) {
		return false
	}
	if node.Type == "tool" {
		name, _ := node.Config["tool"].(string)
		return pureTools[name]
	}
	return logicTypes[node.Type] || personTypes[node.Type]
}

// StubRequired lists the steps an agent's test or fixture run may not
// execute: they would send data out or read a secret before a person
// approved the workflow.
func StubRequired(wf *domain.Workflow) []string {
	ids := []string{}
	for _, node := range wf.Nodes {
		if !pureStep(node) && (!triggerTypes[node.Type] || mentionsSensitive(node.Config)) {
			ids = append(ids, node.ID)
		}
	}
	return ids
}

// ReachesOut lists what keeps a publication from going live on its receipt
// alone: every step that is not pure, triggers included, and declared
// outputs that mention a secret.
func ReachesOut(wf *domain.Workflow) []string {
	ids := []string{}
	for _, node := range wf.Nodes {
		if !pureStep(node) {
			ids = append(ids, node.ID)
		}
	}
	if mentionsSensitive(wf.Outputs) {
		ids = append(ids, "/outputs")
	}
	return ids
}

// Shrink is what a draft takes away from the live version: triggers removed,
// added or reconfigured, steps removed or swapped for another type or tool,
// and declared outputs removed.
type Shrink struct {
	TriggersChanged []string `json:"triggersChanged,omitempty"`
	StepsRemoved    []string `json:"stepsRemoved,omitempty"`
	OutputsRemoved  []string `json:"outputsRemoved,omitempty"`
}

// Reasons maps the shrink to publish request reasons.
func (s Shrink) Reasons() []string {
	reasons := []string{}
	if len(s.TriggersChanged) > 0 {
		reasons = append(reasons, "triggers_changed")
	}
	if len(s.StepsRemoved) > 0 {
		reasons = append(reasons, "steps_removed")
	}
	if len(s.OutputsRemoved) > 0 {
		reasons = append(reasons, "outputs_removed")
	}
	return reasons
}

// Empty reports a purely additive change.
func (s Shrink) Empty() bool {
	return len(s.TriggersChanged) == 0 && len(s.StepsRemoved) == 0 && len(s.OutputsRemoved) == 0
}

// Shrinks compares a draft with the live version it would replace.
func Shrinks(live, draft *domain.Workflow) Shrink {
	drafted := map[string]domain.Node{}
	for _, node := range draft.Nodes {
		drafted[node.ID] = node
	}
	shrink := Shrink{}
	liveTriggers := map[string]bool{}
	for _, node := range live.Nodes {
		next, kept := drafted[node.ID]
		if triggerTypes[node.Type] {
			liveTriggers[node.ID] = true
			if !kept || next.Type != node.Type || !reflect.DeepEqual(normalize(next.Config), normalize(node.Config)) {
				shrink.TriggersChanged = append(shrink.TriggersChanged, node.ID)
			}
			continue
		}
		if !kept || next.Type != node.Type || toolName(next) != toolName(node) {
			shrink.StepsRemoved = append(shrink.StepsRemoved, node.ID)
		}
	}
	for _, node := range draft.Nodes {
		if triggerTypes[node.Type] && !liveTriggers[node.ID] {
			shrink.TriggersChanged = append(shrink.TriggersChanged, node.ID)
		}
	}
	for _, key := range sortedKeys(live.Outputs) {
		if _, kept := draft.Outputs[key]; !kept {
			shrink.OutputsRemoved = append(shrink.OutputsRemoved, key)
		}
	}
	slices.Sort(shrink.TriggersChanged)
	slices.Sort(shrink.StepsRemoved)
	return shrink
}

func toolName(node domain.Node) string {
	name, _ := node.Config["tool"].(string)
	return name
}
