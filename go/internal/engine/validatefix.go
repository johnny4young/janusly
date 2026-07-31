// The Recovery dialog's sandbox gate, ported from the reference's
// replayDeadLetterAsValidation: a proposed fix runs as a FRESH validation
// replay of the suggested workflow — write sides skipped, static
// evidence, trace-only replay lineage back to the failed run — so an
// operator sees real signal before any production mutation.
package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/store"
)

// ErrValidateFixFailingNodeMissing reports a suggestion that dropped the
// failing node — the sandbox could not exercise the failure path.
var ErrValidateFixFailingNodeMissing = errors.New("suggested workflow does not contain the failing node")

// ReplayDeadLetterAsValidation seeds a validation run of the SUGGESTED
// workflow with the original run's resolved input. The new run carries
// replayMode="validation" (write-side skips + static evidence, from
// T-133) and trace-only lineage (parentLinkKind="replay") back to the
// failed run for the Recovery dialog's before/after projection.
func (e *Engine) ReplayDeadLetterAsValidation(
	ctx context.Context, orgID, deadLetterID string, suggested *domain.Workflow, createdBy string,
) (string, error) {
	q := store.New(e.pool)
	item, err := q.GetDeadLetter(ctx, store.GetDeadLetterParams{ID: deadLetterID, OrgID: orgID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrDeadLetterNotFound
		}
		return "", fmt.Errorf("read dead letter: %w", err)
	}

	found := false
	for _, node := range suggested.Nodes {
		if node.ID == item.NodeID {
			found = true
			break
		}
	}
	if !found {
		return "", ErrValidateFixFailingNodeMissing
	}

	// The original run's RESOLVED input seeds the sandbox so the fix is
	// validated against the exact payload that failed.
	var originalInput any
	if run, err := q.GetRunExecution(ctx, item.RunID); err == nil {
		var envelope struct {
			Input any `json:"input"`
		}
		_ = json.Unmarshal(run.InputJson, &envelope)
		originalInput = envelope.Input
	}

	return e.StartRun(ctx, StartInput{
		OrgID: orgID, Workflow: suggested, Input: originalInput,
		CreatedBy: createdBy, ReplayMode: "validation",
		ParentRunID: item.RunID, ParentNodeID: item.NodeID, ParentLinkKind: "replay",
	})
}
