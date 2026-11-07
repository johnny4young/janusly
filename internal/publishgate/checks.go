// Package publishgate is the only path from an agent's draft to production:
// a qualification receipt bound to the draft's digest, then publication.
package publishgate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"sort"
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

// Digest binds a receipt to the exact document and fixtures it qualified.
func Digest(document []byte, fixtures []Fixture) (string, error) {
	rawFixtures, err := json.Marshal(fixtures)
	if err != nil {
		return "", err
	}
	sum := sha256.New()
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
	if len(fixtures) == 0 {
		checks = append(checks, failed("fixtures_missing", "/fixtures",
			"the draft has no behaviour fixtures", "Add at least one fixture with an input and the output it must produce."))
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
		if len(missing.Alternatives) > 0 {
			fix += " Closest: " + strings.Join(missing.Alternatives, ", ") + "."
		}
		checks = append(checks, failed(code, nodePath(missing.NodeID)+"/config/"+missing.Field, message, fix))
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
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// logicTypes compute inside the run and reach nothing outside it. Every other
// step type is part of the outbound surface, which fails closed for new types.
var logicTypes = map[string]bool{
	"transform": true, "condition": true, "noop": true, "router": true,
	"parallel_fork": true, "join": true, "wait_until": true,
}

var contextReference = regexp.MustCompile(`context\.([A-Za-z0-9_-]+)`)

// OutboundSurface lists what a workflow can reach outside its own logic:
// every non-logic step's full config, any logic step that mentions a secret,
// and every step those depend on through templates, because a templated
// target moves when its source does. A change to it needs a person, even
// without writes, because a read can still carry data out.
func OutboundSurface(wf *domain.Workflow) []string {
	configs := map[string]string{}
	types := map[string]string{}
	for _, node := range wf.Nodes {
		raw, _ := json.Marshal(node.Config)
		configs[node.ID], types[node.ID] = string(raw), node.Type
	}
	surface := map[string]bool{}
	var include func(id string)
	include = func(id string) {
		entry := types[id] + " " + id + " " + configs[id]
		if surface[entry] {
			return
		}
		surface[entry] = true
		for _, match := range contextReference.FindAllStringSubmatch(configs[id], -1) {
			if _, known := configs[match[1]]; known && match[1] != id {
				include(match[1])
			}
		}
	}
	for _, node := range wf.Nodes {
		if !logicTypes[node.Type] || strings.Contains(strings.ToLower(configs[node.ID]), "secret") {
			include(node.ID)
		}
	}
	return sortedKeys(surface)
}
