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
// satisfied predecessor. A skipped predecessor satisfies its edge exactly
// like a succeeded one — that is what lets a join fed by a losing
// conditional branch still unblock.
func depsSatisfied(wf *domain.Workflow, nodeID string, statuses map[string]string) bool {
	for _, edge := range wf.Edges {
		if edge.To != nodeID {
			continue
		}
		if from := statuses[edge.From]; from != "succeeded" && from != "skipped" {
			return false
		}
	}
	return true
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
