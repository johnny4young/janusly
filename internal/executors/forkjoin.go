// parallel_fork and join — the declarative fan-out/fan-in pair. Both are
// thin shells over runtime semantics the engine already provides: fan-out
// IS having multiple outgoing edges, "wait for all branches" IS the ALL-AND
// readiness check, and the atomic single claim of the join IS the queue's
// pending→queued transition. The executors only validate declarations and
// shape outputs; implements parallel-fork.ts with its verbatim messages.
package executors

import (
	"context"

	"github.com/johnny4young/janusly/internal/domain"
)

// executeParallelFork validates and echoes the declared branches; fan-out
// is the node's outgoing edges.
func executeParallelFork(_ context.Context, in Input) (any, error) {
	branches, err := domain.ResolveParallelForkBranches(in.Config)
	if err != nil {
		return nil, err
	}
	return map[string]any{"branches": branches}, nil
}

// executeJoin assembles output.branches keyed by label from each declared
// predecessor's context output. A missing output reads as nil, defensively —
// the runtime's fan-in readiness prevents it in practice.
func executeJoin(_ context.Context, in Input) (any, error) {
	sources, err := domain.ResolveJoinSources(in.Config)
	if err != nil {
		return nil, err
	}
	branches := map[string]any{}
	for label, predecessorID := range sources {
		if entry, ok := in.Context[predecessorID].(map[string]any); ok {
			branches[label] = entry["output"]
			continue
		}
		branches[label] = nil
	}
	return map[string]any{"branches": branches}, nil
}
