// DAG readiness computed in code from the workflow snapshot — the queue has
// no scheduler process; whichever worker completes a node decides what runs
// next, inside that completion's transaction.
package engine

import "github.com/johnny4young/janusly/go/internal/domain"

// Node statuses the runtime still schedules work for; a run whose nodes all
// left this set is terminal. Mirrors the reference's open-status set.
var openNodeStatuses = map[string]bool{
	"pending": true, "queued": true, "running": true, "waiting": true,
}

// readySuccessors returns, in declaration order, every pending node whose
// incoming edges all come from satisfied predecessors. A skipped predecessor
// satisfies its edge exactly like a succeeded one — that is what lets a join
// fed by a losing conditional branch still unblock.
func readySuccessors(wf *domain.Workflow, statuses map[string]string) []string {
	satisfied := func(status string) bool {
		return status == "succeeded" || status == "skipped"
	}
	var ready []string
	for _, node := range wf.Nodes {
		if statuses[node.ID] != "pending" {
			continue
		}
		ok := true
		for _, edge := range wf.Edges {
			if edge.To != node.ID {
				continue
			}
			if !satisfied(statuses[edge.From]) {
				ok = false
				break
			}
		}
		if ok {
			ready = append(ready, node.ID)
		}
	}
	return ready
}
