// Fork/join readiness rules, ported from the reference's readiness gate:
// authoring-mistake guards with severities, separate from structural
// validation because a workflow tripping only the warn-level rule still
// runs. Fail-level issues are meant for a production-mode start gate; until
// the pilot grows that flag, callers decide enforcement.
package domain

// ReadinessIssue is one gate finding: stable code, severity, message.
type ReadinessIssue struct {
	Code     string `json:"code"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
	NodeID   string `json:"nodeId,omitempty"`
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
					Message: "Parallel-fork node \"" + node.ID + "\" has no `join` node downstream. The workflow can run, but branch outputs won't be merged into a single labelled record.",
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
					Message: "Parallel-fork node \"" + node.ID + "\" declares branch labels no downstream join maps completely in `config.sources`.",
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
						Message: "Join node \"" + node.ID + "\" references predecessor \"" + predecessorID + "\" for branch \"" + label + "\", but that node is not reachable as an upstream of this join.",
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
