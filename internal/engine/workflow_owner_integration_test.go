//go:build integration

package engine

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/internal/store"
)

// Owner and ingest lookups answer only for the caller's organization; another
// organization's id is reported as taken and nothing more.
func TestWorkflowOwnerLookupsStayInTheOrganization(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	other := org + "-other"
	workflowID := "wf-owner-" + org
	doc := fmt.Sprintf(`{"id":"%s","name":"owner","nodes":[{"id":"only","type":"noop","config":{}}],"edges":[]}`, workflowID)
	if _, err := eng.SaveWorkflowVersion(ctx, SaveWorkflowVersionInput{OrgID: other, UserID: "u", Workflow: mustParse(t, doc)}); err != nil {
		t.Fatalf("save in the other organization: %v", err)
	}
	q := store.New(pool)

	if _, err := q.GetWorkflowIngestState(ctx, store.GetWorkflowIngestStateParams{OrgID: org, ID: workflowID}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("ingest state leaked another organization's workflow: %v", err)
	}
	if _, err := q.GetWorkflowOwnerState(ctx, store.GetWorkflowOwnerStateParams{OrgID: org, ID: workflowID}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("owner state leaked another organization's workflow: %v", err)
	}
	if _, err := eng.SaveWorkflowVersion(ctx, SaveWorkflowVersionInput{OrgID: org, UserID: "u", Workflow: mustParse(t, doc)}); !errors.Is(err, ErrWorkflowSaveIDTaken) {
		t.Fatalf("saving another organization's id: %v, want id taken", err)
	}
	if owner, err := q.ResolvePublicCallbackWorkflowOrg(ctx, workflowID); err != nil || owner != other {
		t.Fatalf("public callback owner = %q %v", owner, err)
	}

	if _, err := pool.Exec(ctx, `UPDATE workflows SET deleted_at = now() WHERE org_id = $1 AND id = $2`, other, workflowID); err != nil {
		t.Fatal(err)
	}
	if _, err := eng.SaveWorkflowVersion(ctx, SaveWorkflowVersionInput{OrgID: other, UserID: "u", Workflow: mustParse(t, doc)}); !errors.Is(err, ErrWorkflowSaveNotFound) {
		t.Fatalf("saving over the organization's own tombstone: %v, want not found", err)
	}
	if _, err := q.ResolvePublicCallbackWorkflowOrg(ctx, workflowID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("a tombstoned workflow still resolves for public callbacks: %v", err)
	}
}
