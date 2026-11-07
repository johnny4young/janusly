package mcpserver

import (
	"context"
	"errors"
	"slices"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/agentclient"
	"github.com/johnny4young/janusly/internal/store"
)

// ActorResolver authenticates the agent client behind one request. A nil
// resolver keeps the operator actor configured on Deps.
type ActorResolver func(ctx context.Context, req mcp.Request) (*agentclient.Principal, error)

// callActor is one request's agent identity plus its lazily resolved scope.
type callActor struct {
	principal *agentclient.Principal
	once      sync.Once
	scope     map[string]bool
	scopeErr  error
}

type callActorKey struct{}

func withCallActor(ctx context.Context, principal *agentclient.Principal) context.Context {
	return context.WithValue(ctx, callActorKey{}, &callActor{principal: principal})
}

// at binds Deps to the request's agent, so every org, actor and permission
// read inside a handler comes from the authenticated client.
func (d Deps) at(ctx context.Context) Deps {
	actor, _ := ctx.Value(callActorKey{}).(*callActor)
	if actor == nil {
		return d
	}
	d.OrgID = actor.principal.OrgID
	d.UserID = actor.principal.ActorID()
	d.Permissions = actor.principal.Permissions
	d.actor = actor
	return d
}

func (d Deps) agent() *agentclient.Principal {
	if d.actor == nil {
		return nil
	}
	return d.actor.principal
}

func (d Deps) onBehalfOf() string {
	if principal := d.agent(); principal != nil {
		return principal.CreatedBy
	}
	return ""
}

func (d Deps) scoped() bool {
	return d.agent() != nil && d.agent().Scoped()
}

// scopeSet is the explicit workflow ids plus every workflow carrying a scope
// tag, resolved once per call.
func (d Deps) scopeSet(ctx context.Context) (map[string]bool, error) {
	d.actor.once.Do(func() {
		principal := d.actor.principal
		set := map[string]bool{}
		for _, id := range principal.ScopeWorkflowIDs {
			set[id] = true
		}
		ids, err := store.New(d.Pool).ResolveAgentScopeWorkflowIDs(ctx, store.ResolveAgentScopeWorkflowIDsParams{
			OrgID: principal.OrgID, WorkflowIds: principal.ScopeWorkflowIDs, Tags: principal.ScopeTags,
		})
		if err != nil {
			d.actor.scopeErr = err
			return
		}
		for _, id := range ids {
			set[id] = true
		}
		d.actor.scope = set
	})
	return d.actor.scope, d.actor.scopeErr
}

func (d Deps) scopeList(ctx context.Context) ([]string, error) {
	set, err := d.scopeSet(ctx)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(set))
	for id := range set {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return ids, nil
}

// workflowVisible is true for unscoped callers. Tools answer an invisible
// workflow with their own not-found text, so scope reads like absence.
func (d Deps) workflowVisible(ctx context.Context, workflowID string) (bool, error) {
	if !d.scoped() {
		return true, nil
	}
	set, err := d.scopeSet(ctx)
	if err != nil {
		return false, err
	}
	return set[workflowID], nil
}

// Each lookup below treats a missing row as visible so the tool's own
// not-found path answers it.

func (d Deps) runVisible(ctx context.Context, runID string) (bool, error) {
	if !d.scoped() {
		return true, nil
	}
	workflowID, err := store.New(d.Pool).GetRunWorkflowForOrg(ctx, store.GetRunWorkflowForOrgParams{OrgID: d.OrgID, ID: runID})
	return d.visibleOwner(ctx, workflowID, err)
}

func (d Deps) deadLetterVisible(ctx context.Context, deadLetterID string) (bool, error) {
	if !d.scoped() {
		return true, nil
	}
	workflowID, err := store.New(d.Pool).GetDeadLetterWorkflowForOrg(ctx, store.GetDeadLetterWorkflowForOrgParams{OrgID: d.OrgID, ID: deadLetterID})
	return d.visibleOwner(ctx, workflowID, err)
}

func (d Deps) recoveryCaseVisible(ctx context.Context, caseID string) (bool, error) {
	if !d.scoped() {
		return true, nil
	}
	workflowID, err := store.New(d.Pool).GetRecoveryCaseWorkflowForOrg(ctx, store.GetRecoveryCaseWorkflowForOrgParams{OrgID: d.OrgID, ID: caseID})
	return d.visibleOwner(ctx, workflowID, err)
}

// hiddenResult answers a failed scope lookup as an error and an invisible
// resource with the tool's own not-found text.
func hiddenResult(err error, notFound string) (*mcp.CallToolResult, any, error) {
	if err != nil {
		return nil, nil, err
	}
	return expected(notFound)
}

func (d Deps) visibleOwner(ctx context.Context, workflowID string, lookupErr error) (bool, error) {
	if errors.Is(lookupErr, pgx.ErrNoRows) {
		return true, nil
	}
	if lookupErr != nil {
		return false, lookupErr
	}
	return d.workflowVisible(ctx, workflowID)
}
