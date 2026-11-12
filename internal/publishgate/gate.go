package publishgate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/runstart"
	"github.com/johnny4young/janusly/internal/store"
)

const (
	// FixtureTimeout bounds how long a receipt may wait for its fixture runs.
	FixtureTimeout = 10 * time.Minute
	// ReceiptLifetime is how long a passed receipt can back a publication.
	ReceiptLifetime = 24 * time.Hour
	// RequestLifetime is how long a person has to decide a publish request.
	RequestLifetime = 24 * time.Hour
)

// FixtureRun is one fixture's validation run and verdict.
type FixtureRun struct {
	Fixture string `json:"fixture"`
	RunID   string `json:"runId,omitempty"`
	Status  string `json:"status"`
	Detail  string `json:"detail,omitempty"`
}

// Gate carries the shared dependencies.
type Gate struct {
	Engine *engine.Engine
	Pool   *pgxpool.Pool
	NewID  func() string
	Now    func() time.Time
}

func (g Gate) now() time.Time {
	if g.Now != nil {
		return g.Now()
	}
	return time.Now()
}

// DraftWorkflow decodes a stored draft into the workflow it proposes.
func DraftWorkflow(draft store.WorkflowDraft) (*domain.Workflow, map[string]any, []Fixture, error) {
	wf, _ := domain.Parse(draft.Document)
	var document map[string]any
	var fixtures []Fixture
	if wf == nil || json.Unmarshal(draft.Document, &document) != nil || json.Unmarshal(draft.Fixtures, &fixtures) != nil {
		return nil, nil, nil, errors.New("stored draft is unreadable")
	}
	return wf, document, fixtures, nil
}

// StartFixtureRuns runs each fixture as a draft-test validation run, so every
// write stays suppressed and stubs replace the steps they name.
func (g Gate) StartFixtureRuns(ctx context.Context, orgID, actor string, wf *domain.Workflow, fixtures []Fixture) ([]FixtureRun, error) {
	runs := make([]FixtureRun, 0, len(fixtures))
	for _, fixture := range fixtures {
		test := engine.DraftTest{Pins: map[string]engine.DraftData{}}
		for nodeID, output := range fixture.Stubs {
			test.Pins[nodeID] = engine.DraftData{Kind: "mocked", Output: output}
		}
		var input any
		if fixture.Input != nil {
			input = fixture.Input
		}
		started, err := (runstart.Service{Engine: g.Engine, Pool: g.Pool, NewID: g.NewID}).Start(ctx, runstart.Request{
			OrgID: orgID, CreatedBy: actor, ServicePrincipal: actor, Workflow: wf, Input: input, DraftTest: &test,
		})
		if err != nil {
			var rejection *runstart.Rejection
			if errors.As(err, &rejection) {
				runs = append(runs, FixtureRun{Fixture: fixture.Name, Status: "failed", Detail: rejection.Code + ": " + rejection.Message})
				continue
			}
			// No receipt will judge the runs already started, so stop them.
			for _, run := range runs {
				if run.RunID != "" {
					_ = g.Engine.CancelRun(context.WithoutCancel(ctx), run.RunID, "fixture run abandoned")
				}
			}
			return nil, err
		}
		runs = append(runs, FixtureRun{Fixture: fixture.Name, RunID: started.RunID, Status: "running"})
	}
	return runs, nil
}

// Settle evaluates a running receipt's fixture runs and records the verdict
// once they all ended or the timeout passed. Other receipts return as stored.
func (g Gate) Settle(ctx context.Context, receipt store.DraftQualification, fixtures []Fixture) (store.DraftQualification, error) {
	if receipt.Status != "running" {
		return receipt, nil
	}
	var runs []FixtureRun
	var checks []Check
	if json.Unmarshal(receipt.FixtureRuns, &runs) != nil || json.Unmarshal(receipt.Checks, &checks) != nil {
		return receipt, errors.New("stored receipt is unreadable")
	}
	ids := []string{}
	for _, run := range runs {
		if run.RunID != "" {
			ids = append(ids, run.RunID)
		}
	}
	q := store.New(g.Pool)
	outcomes, err := q.ListRunOutcomesForOrg(ctx, store.ListRunOutcomesForOrgParams{OrgID: receipt.OrgID, RunIds: ids})
	if err != nil {
		return receipt, err
	}
	byID := map[string]store.ListRunOutcomesForOrgRow{}
	for _, outcome := range outcomes {
		byID[outcome.ID] = outcome
	}
	expectations := map[string]Expectation{}
	for _, fixture := range fixtures {
		expectations[fixture.Name] = fixture.Expect
	}
	pending := false
	open := []string{}
	for index, run := range runs {
		if run.Status != "running" {
			continue
		}
		outcome, ok := byID[run.RunID]
		verdict, detail, done := judge(expectations[run.Fixture], outcome, ok)
		if !done {
			pending = true
			continue
		}
		runs[index].Status, runs[index].Detail = verdict, detail
		if ok && outcome.Status != "succeeded" && outcome.Status != "failed" && outcome.Status != "cancelled" {
			open = append(open, run.RunID)
		}
	}
	timedOut := g.now().After(receipt.CreatedAt.Add(FixtureTimeout))
	if pending && !timedOut {
		return receipt, nil
	}
	for _, run := range runs {
		if run.Status == "running" && run.RunID != "" {
			open = append(open, run.RunID)
		}
	}
	// A judged fixture run is evidence, not work: never leave it waiting.
	for _, runID := range open {
		if err := g.Engine.CancelRun(ctx, runID, "fixture judged"); err != nil && !errors.Is(err, engine.ErrRunAlreadyTerminal) {
			return receipt, err
		}
	}
	status := "passed"
	for index, run := range runs {
		if run.Status == "running" {
			runs[index].Status, runs[index].Detail = "failed", "the run did not finish within 10 minutes"
		}
		if runs[index].Status != "passed" {
			status = "failed"
			checks = append(checks, failed("fixture_failed", "/fixtures", fmt.Sprintf("fixture %q: %s", run.Fixture, runs[index].Detail),
				"Fix the workflow or the fixture; workflows.test runs one case with the same stubs."))
		}
	}
	if !Passed(checks) {
		status = "failed"
	}
	rawChecks, _ := json.Marshal(checks)
	rawRuns, _ := json.Marshal(runs)
	settled, err := q.SettleDraftQualification(ctx, store.SettleDraftQualificationParams{
		OrgID: receipt.OrgID, ID: receipt.ID, Status: status, Checks: rawChecks, FixtureRuns: rawRuns,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return q.GetDraftQualification(ctx, store.GetDraftQualificationParams{OrgID: receipt.OrgID, ID: receipt.ID})
	}
	return settled, err
}

func judge(expect Expectation, outcome store.ListRunOutcomesForOrgRow, found bool) (verdict, detail string, done bool) {
	if !found {
		return "failed", "the fixture run is missing", true
	}
	switch outcome.Status {
	case "succeeded", "failed", "cancelled":
	default:
		if outcome.Waiting && expect.Status == "waiting" {
			return "passed", "", true
		}
		return "", "", false
	}
	if outcome.Status != expect.Status {
		return "failed", fmt.Sprintf("ended %s, expected %s", outcome.Status, expect.Status), true
	}
	if len(expect.Output) > 0 {
		var actual map[string]any
		_ = json.Unmarshal(outcome.OutputJson, &actual)
		if path, ok := contains(actual, expect.Output, "/output"); !ok {
			return "failed", "output differs at " + path, true
		}
	}
	return "passed", "", true
}

// contains reports whether actual holds every expected field with an equal
// value; it returns the first differing path.
func contains(actual, expected map[string]any, path string) (string, bool) {
	for _, key := range sortedKeys(expected) {
		want, got := expected[key], actual[key]
		wantMap, wantIsMap := want.(map[string]any)
		gotMap, gotIsMap := got.(map[string]any)
		if wantIsMap && gotIsMap {
			if differing, ok := contains(gotMap, wantMap, path+"/"+key); !ok {
				return differing, false
			}
			continue
		}
		if !reflect.DeepEqual(normalize(want), normalize(got)) {
			return path + "/" + key, false
		}
	}
	return "", true
}

func normalize(value any) any {
	raw, err := json.Marshal(value)
	if err != nil {
		return value
	}
	var out any
	_ = json.Unmarshal(raw, &out)
	return out
}

// Reasons names why a person must approve a publication; none means the
// receipt alone may publish it. The shrink says what a draft takes away from
// the live version.
func Reasons(ctx context.Context, q *store.Queries, orgID, workflowID string, wf *domain.Workflow) ([]string, Shrink, error) {
	reasons := []string{}
	shrink := Shrink{}
	live, err := q.GetLatestWorkflowVersion(ctx, store.GetLatestWorkflowVersionParams{WorkflowID: workflowID, OrgID: orgID})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		reasons = append(reasons, "first_publish")
	case err != nil:
		return nil, shrink, err
	default:
		liveWorkflow, issues := domain.Parse(live.DagJson)
		if liveWorkflow == nil {
			return nil, shrink, fmt.Errorf("live workflow version %s is unreadable: %v", live.ID, issues)
		}
		shrink = Shrinks(liveWorkflow, wf)
		reasons = append(reasons, shrink.Reasons()...)
	}
	if len(EffectNodes(wf)) > 0 {
		reasons = append(reasons, "writes")
	}
	if len(ReachesOut(wf)) > 0 {
		reasons = append(reasons, "outbound")
	}
	callers, err := q.WorkflowHasCallers(ctx, store.WorkflowHasCallersParams{OrgID: orgID, WorkflowID: workflowID})
	if err != nil {
		return nil, shrink, err
	}
	if callers {
		reasons = append(reasons, "callers")
	}
	return reasons, shrink, nil
}

// ErrStaleBase rejects a draft whose workflow gained a version since it was
// drafted: publishing it would silently undo that change.
var ErrStaleBase = errors.New("the workflow changed since this draft")

// ErrReceiptNotUsable rejects a receipt that does not back this draft.
var ErrReceiptNotUsable = errors.New("qualification does not back this draft")

// UsableReceipt settles a receipt and requires it to have passed, to match the
// draft's digest and to be recent enough.
func (g Gate) UsableReceipt(ctx context.Context, draft store.WorkflowDraft, receipt store.DraftQualification) (store.DraftQualification, error) {
	_, _, fixtures, err := DraftWorkflow(draft)
	if err != nil {
		return receipt, err
	}
	receipt, err = g.Settle(ctx, receipt, fixtures)
	if err != nil {
		return receipt, err
	}
	if receipt.DraftID != draft.ID || receipt.Digest != draft.Digest || receipt.Status != "passed" ||
		g.now().After(receipt.CreatedAt.Add(ReceiptLifetime)) {
		return receipt, ErrReceiptNotUsable
	}
	return receipt, nil
}

// PublishInput appends a qualified draft as the workflow's next version.
type PublishInput struct {
	OrgID, Actor string
	Draft        store.WorkflowDraft
	// Tag keeps a new workflow inside the scope of the client that drafted
	// it; set it only on a first publication.
	Tag string
}

// Publish appends the draft through the same canonical engine path as a
// save, so it joins the one ordered history and reconciles schedules.
func (g Gate) Publish(ctx context.Context, in PublishInput) (engine.SaveWorkflowVersionResult, error) {
	wf, _, _, err := DraftWorkflow(in.Draft)
	if err != nil {
		return engine.SaveWorkflowVersionResult{}, err
	}
	// Tag first: a version saved without its tag would leave the new
	// workflow outside the drafting client's scope.
	if in.Tag != "" {
		if err := store.New(g.Pool).TagWorkflowIfUntagged(ctx, store.TagWorkflowIfUntaggedParams{
			ID: g.NewID(), OrgID: in.OrgID, WorkflowID: wf.ID, Tag: in.Tag,
		}); err != nil {
			return engine.SaveWorkflowVersionResult{}, err
		}
	}
	base := in.Draft.BaseVersionID.String
	saved, err := g.Engine.SaveWorkflowVersion(ctx, engine.SaveWorkflowVersionInput{
		OrgID: in.OrgID, UserID: in.Actor, Workflow: wf, NewID: g.NewID, ExpectedBaseVersionID: &base,
	})
	if errors.Is(err, engine.ErrWorkflowSaveBaseMoved) {
		return saved, ErrStaleBase
	}
	return saved, err
}

// OptionalText maps an empty string to NULL.
func OptionalText(value string) pgtype.Text {
	return pgtype.Text{String: value, Valid: value != ""}
}
