//go:build integration

package engine

import (
	"errors"
	"testing"
)

// The plan reads the source before the start transaction, so a redrive can land
// between them: the start must see it under the lock redrive also takes.
func TestStartRunRefusesARerunOfARevivedSource(t *testing.T) {
	ctx, _, eng, org := newHarness(t)
	wf := mustParse(t, linearDoc)
	sourceRunID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
	if err != nil {
		t.Fatalf("start source: %v", err)
	}
	_, err = eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf, Rerun: &RerunSeed{
		SourceRunID: sourceRunID, NodeID: wf.Nodes[0].ID, Nodes: map[string]NodeSeed{},
	}})
	if !errors.Is(err, ErrRerunSourceOpen) {
		t.Fatalf("a source still running must refuse the rerun: %v", err)
	}
}
