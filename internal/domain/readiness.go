// Readiness rules, implements the contract's deterministic gate
// (the source contract): authoring-mistake guards
// with severities, separate from structural validation because a workflow
// tripping only warn-level rules still runs. Fail-level issues block the
// production-mode start gate (JANUSLY_PRODUCTION_MODE=true); rules-only,
// never an LLM.
package domain

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/johnny4young/janusly/internal/grammar"
)

// ReadinessIssue is one gate finding: stable code, severity, message, and
// the optional hint the badge expansion shows next to it.
type ReadinessIssue struct {
	Code       string `json:"code"`
	Severity   string `json:"severity"`
	Message    string `json:"message"`
	NodeID     string `json:"nodeId,omitempty"`
	EdgeID     string `json:"edgeId,omitempty"`
	Suggestion string `json:"suggestion,omitempty"`
}

// ReadinessResult is the flat issue list + rolled-up status (worst wins).
type ReadinessResult struct {
	Status string           `json:"status"`
	Issues []ReadinessIssue `json:"issues"`
}

// ReadinessOptions carries the seams the pure checks need from the caller.
type ReadinessOptions struct {
	// IsWriteSideTool classifies a tool invocation; nil means "unknown →
	// read-side" (the contract resolves this from its tool registry).
	IsWriteSideTool func(tool string, input map[string]any) bool
	// RequireEvalCoverage mirrors JANUSLY_REQUIRE_EVAL_COVERAGE: opt-in
	// warn until eval tracking exists, default-off so a clean workflow can
	// reach "pass".
	RequireEvalCoverage bool
}

var (
	sensitiveHTTPMethods = map[string]bool{"POST": true, "PUT": true, "PATCH": true, "DELETE": true}
	sensitiveToolNames   = map[string]bool{
		"email.send": true, "slack.post": true, "github.create_issue": true,
		"linear.create_issue": true, "db.query.write": true, "db.query.transaction": true,
	}
	sensitiveToolSuffixes = []string{".write", ".create", ".send", ".delete", ".update"}
	secretTemplatePattern = regexp.MustCompile(`\{\{\s*(secret|env)\.[A-Za-z0-9_-]+\s*\}\}`)
)

// CheckWorkflowReadiness runs every deterministic readiness check in the
// contract's order and rolls the severities up. Pure; DB-layered issues
// (rollback availability) are merged by the API caller.
func CheckWorkflowReadiness(wf *Workflow, opts ReadinessOptions) ReadinessResult {
	var issues []ReadinessIssue
	approvalCache := map[string]bool{}
	for _, node := range wf.Nodes {
		checkHTTPBounds(node, &issues)
		checkExternalRetry(node, opts, &issues)
		checkToolResultPolicy(node, opts, &issues)
		checkRawSecretsInConfig(node, &issues)
		checkSensitiveApproval(node, wf, opts, approvalCache, &issues)
	}
	issues = append(issues, CheckForkJoinReadiness(wf)...)
	if len(wf.Outputs) == 0 {
		issues = append(issues, ReadinessIssue{
			Code: "workflow_missing_outputs", Severity: "warn",
			Message:    "Workflow declares no `outputs` projection — terminal state will be opaque to downstream consumers.",
			Suggestion: "Add an `outputs` map to the workflow root, e.g. { result: '{{context.<lastStep>.output.<field>}}' }.",
		})
	}
	if opts.RequireEvalCoverage {
		issues = append(issues, ReadinessIssue{
			Code: "workflow_missing_evals", Severity: "warn",
			Message:    "Eval coverage tracking is not yet enabled. Once eval cases exist, this warn flips off automatically.",
			Suggestion: "Add eval cases via the evals harness when available; meanwhile, this warn is informational and not blocking.",
		})
	}
	if issues == nil {
		issues = []ReadinessIssue{}
	}
	return ReadinessResult{Status: rollupReadiness(issues), Issues: issues}
}

func rollupReadiness(issues []ReadinessIssue) string {
	status := "pass"
	for _, issue := range issues {
		if issue.Severity == "fail" {
			return "fail"
		}
		status = "warn"
	}
	return status
}

func checkHTTPBounds(node Node, issues *[]ReadinessIssue) {
	if node.Type != "http" {
		return
	}
	for _, field := range []string{"timeoutMs", "maxResponseBytes", "maxRedirects"} {
		if _, ok := node.Config[field].(float64); ok {
			return
		}
	}
	*issues = append(*issues, ReadinessIssue{
		Code: "http_missing_bounds", Severity: "warn", NodeID: node.ID,
		Message:    fmt.Sprintf("HTTP node %q relies on the platform defaults (30s timeout / 1 MB body cap / 5 redirect hops).", node.ID),
		Suggestion: "Set at least one of `timeoutMs`, `maxResponseBytes`, or `maxRedirects` to record the operator's intent. Defaults still apply if unset.",
	})
}

func checkExternalRetry(node Node, opts ReadinessOptions, issues *[]ReadinessIssue) {
	// Automatic whole-node retries are only a readiness requirement when
	// the call is statically read-side: write-side HTTP/tools can have
	// committed before failing, so the runtime suppresses blind retries.
	var retrySafe bool
	switch node.Type {
	case "http":
		retrySafe = !isSensitiveAction(node, opts)
	case "tool":
		toolName, _ := node.Config["tool"].(string)
		toolInput, _ := node.Config["input"].(map[string]any)
		retrySafe = !isWriteSideTool(opts, toolName, toolInput)
	default:
		return
	}
	if !retrySafe {
		return
	}
	maxAttempts := 1.0
	if retry, ok := node.Config["retry"].(map[string]any); ok {
		if value, ok := retry["maxAttempts"].(float64); ok {
			maxAttempts = value
		}
	}
	if maxAttempts >= 2 {
		return
	}
	*issues = append(*issues, ReadinessIssue{
		Code: "external_node_missing_retry", Severity: "fail", NodeID: node.ID,
		Message:    fmt.Sprintf("Read-side node %q makes an external call but has no retry policy. Transient failures will mark the run failed instead of being retried.", node.ID),
		Suggestion: "Set `config.retry.maxAttempts` to at least 2; production-grade is typically 3–5 with exponential backoff.",
	})
}

func checkToolResultPolicy(node Node, opts ReadinessOptions, issues *[]ReadinessIssue) {
	if node.Type != "tool" {
		return
	}
	toolName, _ := node.Config["tool"].(string)
	toolInput, _ := node.Config["input"].(map[string]any)
	if !isWriteSideTool(opts, toolName, toolInput) {
		return
	}
	if policy, _ := node.Config["resultPolicy"].(string); policy == "require_ok" {
		return
	}
	*issues = append(*issues, ReadinessIssue{
		Code: "tool_result_policy_missing", Severity: "fail", NodeID: node.ID,
		Message:    fmt.Sprintf("Write-side tool node %q can return a failed result envelope without failing the run.", node.ID),
		Suggestion: "Set `config.resultPolicy` to `require_ok` so failed provider envelopes enter DLQ and recovery without unsafe blind retries.",
	})
}

func checkRawSecretsInConfig(node Node, issues *[]ReadinessIssue) {
	walkConfig(node.Config, func(key string, value any) {
		if !grammar.IsSensitiveKey(key) {
			return
		}
		text, ok := value.(string)
		if !ok {
			return
		}
		if strings.TrimSpace(text) == "" || secretTemplatePattern.MatchString(text) {
			return
		}
		*issues = append(*issues, ReadinessIssue{
			Code: "raw_secret_in_config", Severity: "fail", NodeID: node.ID,
			Message: fmt.Sprintf("Node %q hardcodes what looks like a secret in field `%s`. The persistence chokepoint will scrub it at write time, but the saved workflow JSON still carries the literal value.", node.ID, key),
			Suggestion: fmt.Sprintf("Replace the value with a supported template reference such as `{{secret.%s}}` / `{{env.%s}}`, or move the call to an integration tool that references an operator-managed credential by name.",
				strings.ToUpper(key), strings.ToUpper(key)),
		})
	})
}

func checkSensitiveApproval(node Node, wf *Workflow, opts ReadinessOptions, cache map[string]bool, issues *[]ReadinessIssue) {
	if !isSensitiveAction(node, opts) {
		return
	}
	if hasApprovalAncestor(wf, node.ID, cache) {
		return
	}
	*issues = append(*issues, ReadinessIssue{
		Code: "sensitive_action_missing_approval", Severity: "warn", NodeID: node.ID,
		Message:    fmt.Sprintf("Node %q performs a write-side action without a human-approval gate upstream. Verify this is intentional for production.", node.ID),
		Suggestion: "Add an `approval` node upstream so a human can review before the write fires. Or document why this workflow runs unattended.",
	})
}

func isWriteSideTool(opts ReadinessOptions, tool string, input map[string]any) bool {
	if opts.IsWriteSideTool == nil || tool == "" {
		return false
	}
	return opts.IsWriteSideTool(tool, input)
}

func isSensitiveAction(node Node, opts ReadinessOptions) bool {
	switch node.Type {
	case "http":
		method := "GET"
		if raw, ok := node.Config["method"].(string); ok && raw != "" {
			method = strings.ToUpper(raw)
		}
		return sensitiveHTTPMethods[method]
	case "tool":
		tool, ok := node.Config["tool"].(string)
		if !ok {
			return false
		}
		if sensitiveToolNames[tool] {
			return true
		}
		for _, suffix := range sensitiveToolSuffixes {
			if strings.HasSuffix(tool, suffix) {
				return true
			}
		}
		return false
	case "loop":
		if mode, _ := node.Config["mode"].(string); mode == "for_each" {
			toolName, _ := node.Config["tool"].(string)
			toolInput, _ := node.Config["input"].(map[string]any)
			return isWriteSideTool(opts, toolName, toolInput)
		}
		return false
	case "mcp_tool":
		// External MCP invocations are write-side by default (fail-safe,
		// matching the descriptor table's own posture).
		return true
	}
	return false
}

func hasApprovalAncestor(wf *Workflow, nodeID string, cache map[string]bool) bool {
	if cached, ok := cache[nodeID]; ok {
		return cached
	}
	typesByID := map[string]string{}
	for _, node := range wf.Nodes {
		typesByID[node.ID] = node.Type
	}
	for id := range collectAncestors(wf, nodeID) {
		if typesByID[id] == "approval" {
			cache[nodeID] = true
			return true
		}
	}
	cache[nodeID] = false
	return false
}

func walkConfig(value any, visit func(key string, value any)) {
	switch container := value.(type) {
	case []any:
		for _, item := range container {
			walkConfig(item, visit)
		}
	case map[string]any:
		for key, item := range container {
			visit(key, item)
			walkConfig(item, visit)
		}
	}
}

// CheckForkJoinReadiness runs the three fork/join rules:
//   - fork_without_join_pair (warn): branches run but never merge.
//   - join_sources_unreachable (fail): a source that is not an ancestor.
//   - fork_join_missing_branch_sources (fail): no downstream join covers
//     every declared branch label.
func CheckForkJoinReadiness(wf *Workflow) []ReadinessIssue {
	var issues []ReadinessIssue
	for _, node := range wf.Nodes {
		switch node.Type {
		case "parallel_fork":
			joins := downstreamJoins(wf, node.ID)
			if len(joins) == 0 {
				issues = append(issues, ReadinessIssue{
					Code: "fork_without_join_pair", Severity: "warn", NodeID: node.ID,
					Message:    "Parallel-fork node \"" + node.ID + "\" has no `join` node downstream. The workflow can run, but branch outputs won't be merged into a single labelled record.",
					Suggestion: "Add a `join` node downstream of every branch so the merged outputs are addressable as `{{context.<join>.output.branches.<label>}}`.",
				})
				continue
			}
			labels := forkLabels(node.Config)
			if len(labels) == 0 {
				continue // executor-time validation catches malformed branches
			}
			covered := false
			for _, join := range joins {
				if joinCoversLabels(join.Config, labels) {
					covered = true
					break
				}
			}
			if !covered {
				issues = append(issues, ReadinessIssue{
					Code: "fork_join_missing_branch_sources", Severity: "fail", NodeID: node.ID,
					Message:    "Parallel-fork node \"" + node.ID + "\" declares branch labels no downstream join maps completely in `config.sources`.",
					Suggestion: "Update the paired `join.config.sources` so it includes every declared fork branch label, e.g. `{ a: '<a_terminal_node>', b: '<b_terminal_node>' }`.",
				})
			}
		case "join":
			sources, ok := node.Config["sources"].(map[string]any)
			if !ok {
				continue // executor-time validation will catch the malformed shape
			}
			ancestors := collectAncestors(wf, node.ID)
			for label, raw := range sources {
				predecessorID, ok := raw.(string)
				if !ok || predecessorID == "" {
					continue
				}
				if !ancestors[predecessorID] {
					issues = append(issues, ReadinessIssue{
						Code: "join_sources_unreachable", Severity: "fail", NodeID: node.ID,
						Message:    "Join node \"" + node.ID + "\" references predecessor \"" + predecessorID + "\" for branch \"" + label + "\", but that node is not reachable as an upstream of this join.",
						Suggestion: "Add an edge from \"" + predecessorID + "\" to \"" + node.ID + "\" (or update the source to a node that is actually a predecessor).",
					})
				}
			}
		}
	}
	return issues
}

func forkLabels(config map[string]any) []string {
	raw, ok := config["branches"].([]any)
	if !ok {
		return nil
	}
	var labels []string
	for _, entry := range raw {
		if item, ok := entry.(map[string]any); ok {
			if label, ok := item["label"].(string); ok && label != "" {
				labels = append(labels, label)
			}
		}
	}
	return labels
}

func joinCoversLabels(config map[string]any, labels []string) bool {
	sources, ok := config["sources"].(map[string]any)
	if !ok {
		return false
	}
	for _, label := range labels {
		value, ok := sources[label].(string)
		if !ok || value == "" {
			return false
		}
	}
	return true
}

func downstreamJoins(wf *Workflow, nodeID string) []Node {
	typesByID := map[string]Node{}
	for _, node := range wf.Nodes {
		typesByID[node.ID] = node
	}
	visited := map[string]bool{}
	stack := []string{}
	for _, edge := range wf.Edges {
		if edge.From == nodeID {
			stack = append(stack, edge.To)
		}
	}
	var joins []Node
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if visited[id] {
			continue
		}
		visited[id] = true
		if node, ok := typesByID[id]; ok && node.Type == "join" {
			joins = append(joins, node)
		}
		for _, edge := range wf.Edges {
			if edge.From == id {
				stack = append(stack, edge.To)
			}
		}
	}
	return joins
}

func collectAncestors(wf *Workflow, nodeID string) map[string]bool {
	ancestors := map[string]bool{}
	stack := []string{}
	for _, edge := range wf.Edges {
		if edge.To == nodeID {
			stack = append(stack, edge.From)
		}
	}
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if ancestors[id] {
			continue
		}
		ancestors[id] = true
		for _, edge := range wf.Edges {
			if edge.To == id {
				stack = append(stack, edge.From)
			}
		}
	}
	return ancestors
}

// SuggestionSafety is the recovery-suggestion safety projection: whether
// the failing node is write-side and whether an approval gate guards it.
// Unparseable input fails SAFE (write-side, approval required, absent).
type SuggestionSafety struct {
	WriteSide        bool `json:"writeSide"`
	ApprovalRequired bool `json:"approvalRequired"`
	ApprovalPresent  bool `json:"approvalPresent"`
}

// ComputeSuggestionSafety mirrors the contract's recoverySuggestionSafety.
func ComputeSuggestionSafety(wf *Workflow, nodeID string) SuggestionSafety {
	if wf == nil {
		return SuggestionSafety{WriteSide: true, ApprovalRequired: true}
	}
	var target *Node
	for i := range wf.Nodes {
		if wf.Nodes[i].ID == nodeID {
			target = &wf.Nodes[i]
			break
		}
	}
	if target == nil {
		return SuggestionSafety{WriteSide: true, ApprovalRequired: true}
	}
	writeSide := isSensitiveAction(*target, ReadinessOptions{})
	approvalPresent := !writeSide || hasApprovalAncestor(wf, nodeID, map[string]bool{})
	return SuggestionSafety{WriteSide: writeSide, ApprovalRequired: writeSide, ApprovalPresent: approvalPresent}
}

// IsSensitiveActionNode exposes the write-side classifier for dispatch.
func IsSensitiveActionNode(node Node) bool { return isSensitiveAction(node, ReadinessOptions{}) }

// HasApprovalAncestorIn exposes the ancestor scan for dispatch.
func HasApprovalAncestorIn(wf *Workflow, nodeID string) bool {
	return hasApprovalAncestor(wf, nodeID, map[string]bool{})
}
