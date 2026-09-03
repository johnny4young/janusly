// DAG readiness computed in code from the workflow snapshot — the queue has
// no scheduler process; whichever worker completes a node decides what runs
// next, inside that completion's transaction.
package engine

import "github.com/johnny4young/janusly/internal/domain"

// Node statuses the runtime still schedules work for; a run whose nodes all
// left this set is terminal. Mirrors the contract's open-status set.
var openNodeStatuses = map[string]bool{
	"pending": true, "queued": true, "running": true, "waiting": true,
}

// depsSatisfied reports whether every incoming edge of the node comes from a
// satisfied predecessor. A skipped predecessor satisfies a normal edge
// exactly like a succeeded one — that is what lets a join fed by a losing
// conditional branch still unblock. An on-error edge inverts the rule: it
// is satisfied only by a FAILED source (the handled-failure branch).
func depsSatisfied(wf *domain.Workflow, nodeID string, statuses map[string]string) bool {
	for _, edge := range wf.Edges {
		if edge.To != nodeID {
			continue
		}
		from := statuses[edge.From]
		if edge.OnError {
			if from != "failed" {
				return false
			}
		} else if from != "succeeded" && from != "skipped" {
			return false
		}
	}
	return true
}

// depsDoomed reports whether some incoming edge can never be satisfied:
// an on-error edge whose source ended without failing, or a normal edge
// whose source failed (only reachable when that failure was handled —
// an unhandled failure flips the whole run before this matters). Doomed
// pending nodes get skipped so the run can settle.
func depsDoomed(wf *domain.Workflow, nodeID string, statuses map[string]string) bool {
	for _, edge := range wf.Edges {
		if edge.To != nodeID {
			continue
		}
		from := statuses[edge.From]
		if edge.OnError {
			if from == "succeeded" || from == "skipped" {
				return true
			}
		} else if from == "failed" {
			return true
		}
	}
	return false
}

// nodeFailureHandled reports whether the workflow declares at least one
// on-error edge out of the node — the author's statement that this
// node's terminal failure is expected and routed, not a run failure.
func nodeFailureHandled(wf *domain.Workflow, nodeID string) bool {
	for _, edge := range wf.Edges {
		if edge.OnError && edge.From == nodeID {
			return true
		}
	}
	return false
}

// readySuccessors returns, in declaration order, every pending node whose
// dependencies are satisfied.
func readySuccessors(wf *domain.Workflow, statuses map[string]string) []string {
	var ready []string
	for _, node := range wf.Nodes {
		if statuses[node.ID] != "pending" {
			continue
		}
		if depsSatisfied(wf, node.ID, statuses) {
			ready = append(ready, node.ID)
		}
	}
	return ready
}
