package operations

// ActionSurface identifies the authenticated transport that will consume an
// Operator Brief. Ranking, evidence, targets and permission evaluation remain
// shared; only executable affordances are projected to the real catalog of the
// consuming surface.
type ActionSurface uint8

const (
	// ActionSurfaceAPI is the zero value because the HTTP/UI surface predates
	// transport projection and is the canonical business-action vocabulary.
	ActionSurfaceAPI ActionSurface = iota
	ActionSurfaceMCP
)

func projectAllowedActions(surface ActionSurface, actions []string) []string {
	if surface == ActionSurfaceAPI {
		return actions
	}
	if surface != ActionSurfaceMCP {
		return []string{}
	}

	projected := make([]string, 0, len(actions))
	seen := make(map[string]struct{}, len(actions))
	for _, action := range actions {
		mapped := ""
		switch action {
		case "recovery.cases.inspect", "recovery.cases.diagnose",
			"recovery.cases.validate", "recovery.cases.apply",
			"runs.inspect", "dlq.redrive":
			mapped = action
		case "recovery.cases.candidates":
			// MCP deliberately composes diagnosis and candidate creation into
			// one bounded tool, and can also call it from diagnosed state.
			mapped = "recovery.cases.diagnose"
		case "dlq.inspect":
			// The MCP catalog exposes a bounded list projection rather than a
			// separate raw dead-letter detail tool.
			mapped = "dlq.list"
		case "recovery.cases.approve", "runs.approve":
			// Human approval is intentionally unavailable to MCP.
			continue
		default:
			// Catalog drift must fail closed rather than advertise a tool that
			// the agent cannot actually invoke.
			continue
		}
		if _, duplicate := seen[mapped]; duplicate {
			continue
		}
		seen[mapped] = struct{}{}
		projected = append(projected, mapped)
	}
	return projected
}
