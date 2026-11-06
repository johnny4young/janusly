package operations

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/authoring"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/store"
)

// Closed vocabularies the browser translates.
var (
	HypothesisIDs      = []string{"network", "credential", "upstream", "change"}
	HypothesisVerdicts = []string{"validated", "ruled_out", "inconclusive"}
	HypothesisReasons  = []string{
		"no_error", "error_unclassified", "network_dns", "network_failed", "network_other_category",
		"credential_missing", "credential_rejected", "credential_expired", "credential_expired_unconfirmed",
		"credential_unused", "credential_unproven",
		"upstream_hidden", "upstream_unwatched", "upstream_degraded", "upstream_current_only", "upstream_unchecked",
		"change_unsaved", "change_no_baseline", "change_same_version", "change_outside_version", "change_new_version",
	}
	EvidenceKinds = []string{"failed_step", "last_success"}
)

var ErrNoFailedStep = errors.New("run has no failed step")

const (
	stepWindow      = 30 * 24 * time.Hour
	historyRunLimit = 200
	// A reading this close to the failure is the only one that can speak for it.
	upstreamNearMinimum = 5 * time.Minute
)

type InvestigationEvidence struct {
	Kind   string `json:"kind"`
	RunID  string `json:"runId"`
	NodeID string `json:"nodeId,omitempty"`
}

type Hypothesis struct {
	ID       string                  `json:"id"`
	Verdict  string                  `json:"verdict"`
	Reason   string                  `json:"reason"`
	Params   map[string]any          `json:"params"`
	Evidence []InvestigationEvidence `json:"evidence"`
}

// InvestigationAction only navigates to the Recover queue, where Suggest fix keeps its own gate.
type InvestigationAction struct {
	Kind         string `json:"kind"`
	DeadLetterID string `json:"deadLetterId"`
}

type Investigation struct {
	RunID        string               `json:"runId"`
	NodeID       string               `json:"nodeId"`
	WorkflowName string               `json:"workflowName"`
	Signature    string               `json:"signature"`
	Category     string               `json:"category"`
	Hypotheses   []Hypothesis         `json:"hypotheses"`
	Conclusion   string               `json:"conclusion"`
	Action       *InvestigationAction `json:"action"`
	GeneratedAt  string               `json:"generatedAt"`
}

type upstreamReading struct {
	Name                 string
	Successful, Degraded bool
	CheckedAt            *time.Time
	Interval             time.Duration
}

type investigationFacts struct {
	RunID, NodeID, WorkflowName string
	Result                      signature.Result
	HasError                    bool
	// UsesCredential: the step binds a credential or holds a secret template.
	// CredentialsComplete: its bindings describe every credential it can use.
	UsesCredential, CredentialsComplete bool
	ExpiredCredential                   string
	ExpiredAt                           *time.Time
	FailedAt, Now                       time.Time
	Version                             int
	SameVersionSuccess                  string
	OlderSuccess                        string
	OlderVersion                        int
	// OutsideVersion: the workflow depends on credentials, connections, AI
	// settings or child workflows, which change without a new version.
	OutsideVersion   bool
	UpstreamVisible  bool
	UpstreamTags     []string
	Upstream         []upstreamReading
	StepRuns         int
	StepSameFailures int
	DeadLetterID     string
	CanFix           bool
}

var secretTemplate = regexp.MustCompile(`\{\{\s*(secret|env)\.`)

func evaluateInvestigation(f investigationFacts) Investigation {
	hypotheses := []Hypothesis{networkHypothesis(f), credentialHypothesis(f), upstreamHypothesis(f), changeHypothesis(f)}
	out := Investigation{
		RunID: f.RunID, NodeID: f.NodeID, WorkflowName: f.WorkflowName,
		Signature: f.Result.Signature, Category: f.Result.Category, Hypotheses: hypotheses,
		GeneratedAt: f.Now.UTC().Format(time.RFC3339Nano),
	}
	for _, item := range hypotheses {
		if item.Verdict == "validated" {
			out.Conclusion = item.ID
			break
		}
	}
	if out.Conclusion != "" && f.CanFix && f.DeadLetterID != "" {
		out.Action = &InvestigationAction{Kind: "open_recovery", DeadLetterID: f.DeadLetterID}
	}
	return out
}

func hypothesis(id, verdict, reason string, params map[string]any, evidence ...InvestigationEvidence) Hypothesis {
	if params == nil {
		params = map[string]any{}
	}
	unique, seen := []InvestigationEvidence{}, map[string]bool{}
	for _, item := range evidence {
		if !seen[item.RunID] {
			seen[item.RunID] = true
			unique = append(unique, item)
		}
	}
	return Hypothesis{ID: id, Verdict: verdict, Reason: reason, Params: params, Evidence: unique}
}

func (f investigationFacts) failedStep() InvestigationEvidence {
	return InvestigationEvidence{Kind: "failed_step", RunID: f.RunID, NodeID: f.NodeID}
}

func networkHypothesis(f investigationFacts) Hypothesis {
	switch {
	case !f.HasError:
		return hypothesis("network", "inconclusive", "no_error", nil)
	case f.Result.Category == "network_timeout":
		reason := "network_failed"
		if strings.HasPrefix(f.Result.Signature, "DNS lookup failed") {
			reason = "network_dns"
		}
		params := map[string]any{
			"signature": f.Result.Signature, "count": max(f.StepSameFailures, 1), "runs": max(f.StepRuns, 1),
		}
		return hypothesis("network", "validated", reason, params, f.failedStep())
	case f.Result.Category == "unknown":
		return hypothesis("network", "inconclusive", "error_unclassified", nil, f.failedStep())
	default:
		return hypothesis("network", "ruled_out", "network_other_category",
			map[string]any{"category": f.Result.Category}, f.failedStep())
	}
}

func credentialHypothesis(f investigationFacts) Hypothesis {
	signatureParams := map[string]any{"signature": f.Result.Signature}
	// Only an auth rejection proves the call reached a service that refused the credential.
	rejected := strings.HasPrefix(f.Result.Signature, "HTTP 401 ") || strings.HasPrefix(f.Result.Signature, "HTTP 403 ")
	var expired map[string]any
	if f.ExpiredAt != nil {
		expired = map[string]any{"credential": f.ExpiredCredential, "expiredAt": f.ExpiredAt.UTC().Format(time.RFC3339)}
	}
	switch {
	case f.Result.Category == "secret_missing":
		return hypothesis("credential", "validated", "credential_missing", signatureParams, f.failedStep())
	case rejected && expired != nil:
		return hypothesis("credential", "validated", "credential_expired", expired, f.failedStep())
	case rejected:
		return hypothesis("credential", "validated", "credential_rejected", signatureParams, f.failedStep())
	case expired != nil:
		return hypothesis("credential", "inconclusive", "credential_expired_unconfirmed", expired, f.failedStep())
	case !f.HasError:
		return hypothesis("credential", "inconclusive", "no_error", nil)
	case f.CredentialsComplete && !f.UsesCredential:
		return hypothesis("credential", "ruled_out", "credential_unused", nil, f.failedStep())
	default:
		return hypothesis("credential", "inconclusive", "credential_unproven", nil, f.failedStep())
	}
}

// near reports whether a reading was taken close enough to the failure to describe it.
func (r upstreamReading) near(failedAt time.Time) bool {
	if r.CheckedAt == nil {
		return false
	}
	gap := r.CheckedAt.Sub(failedAt)
	if gap < 0 {
		gap = -gap
	}
	return gap <= max(2*r.Interval, upstreamNearMinimum)
}

// Only the latest reading of each source is stored, so upstream is never ruled out.
func upstreamHypothesis(f investigationFacts) Hypothesis {
	if !f.UpstreamVisible {
		return hypothesis("upstream", "inconclusive", "upstream_hidden", nil)
	}
	if len(f.UpstreamTags) == 0 {
		return hypothesis("upstream", "inconclusive", "upstream_unwatched", nil)
	}
	read := []string{}
	for _, reading := range f.Upstream {
		if !reading.Successful {
			continue
		}
		if reading.Degraded && reading.near(f.FailedAt) {
			return hypothesis("upstream", "validated", "upstream_degraded", map[string]any{"source": reading.Name})
		}
		read = append(read, reading.Name)
	}
	if len(read) == 0 {
		return hypothesis("upstream", "inconclusive", "upstream_unchecked", nil)
	}
	return hypothesis("upstream", "inconclusive", "upstream_current_only", map[string]any{"sources": strings.Join(read, ", ")})
}

func changeHypothesis(f investigationFacts) Hypothesis {
	switch {
	case f.Version == 0:
		return hypothesis("change", "inconclusive", "change_unsaved", nil)
	case f.SameVersionSuccess != "":
		baseline := InvestigationEvidence{Kind: "last_success", RunID: f.SameVersionSuccess}
		params := map[string]any{"version": f.Version}
		if f.OutsideVersion {
			return hypothesis("change", "inconclusive", "change_outside_version", params, baseline)
		}
		return hypothesis("change", "ruled_out", "change_same_version", params, baseline)
	case f.OlderSuccess != "":
		return hypothesis("change", "validated", "change_new_version",
			map[string]any{"from": f.OlderVersion, "to": f.Version},
			InvestigationEvidence{Kind: "last_success", RunID: f.OlderSuccess})
	default:
		return hypothesis("change", "inconclusive", "change_no_baseline", map[string]any{"version": f.Version})
	}
}

// Investigate gathers tenant-scoped facts for the run's failed step and evaluates every rule.
func (b Builder) Investigate(ctx context.Context, orgID, runID string, permissions map[string]bool) (Investigation, error) {
	now := time.Now().UTC()
	if b.Now != nil {
		now = b.Now().UTC()
	}
	q := store.New(b.Pool)
	run, err := q.GetRunInvestigationContext(ctx, store.GetRunInvestigationContextParams{OrgID: orgID, RunID: runID})
	if err != nil {
		return Investigation{}, err
	}
	nodes, err := q.ListRunNodesByRunForOrg(ctx, store.ListRunNodesByRunForOrgParams{RunID: runID, OrgID: orgID})
	if err != nil {
		return Investigation{}, err
	}
	// The earliest failure is the one that stopped the run; parallel branches may fail after it.
	var failed *store.ListRunNodesByRunForOrgRow
	for index := range nodes {
		node := &nodes[index]
		if node.Status == "failed" && (failed == nil || earlier(node.FinishedAt, failed.FinishedAt)) {
			failed = node
		}
	}
	if failed == nil {
		return Investigation{}, ErrNoFailedStep
	}
	facts := investigationFacts{
		RunID: runID, NodeID: failed.NodeID, Now: now, Version: int(run.Version),
		UpstreamVisible: permissions["upstream.read"], FailedAt: failureTime(failed.FinishedAt, run.CreatedAt, now),
		HasError: len(failed.ErrorJson) > 0 && string(failed.ErrorJson) != "null",
	}

	workflow := snapshotWorkflow(run.InputJson)
	errorContext := signature.Context{NodeID: failed.NodeID}
	var credentialNames []string
	if workflow != nil {
		facts.WorkflowName = signature.ScrubSecretShapes(workflow.Name)
		uses := authoring.StepCredentials(workflow)
		for _, node := range workflow.Nodes {
			use := uses[node.ID]
			config, _ := json.Marshal(node.Config)
			templated := secretTemplate.Match(config)
			if !use.Complete || len(use.Names) > 0 || templated {
				facts.OutsideVersion = true
			}
			if node.ID == failed.NodeID {
				errorContext.NodeType = node.Type
				errorContext.ToolName, _ = node.Config["tool"].(string)
				credentialNames = use.Names
				facts.CredentialsComplete = use.Complete
				facts.UsesCredential = len(use.Names) > 0 || templated
			}
		}
	} else {
		facts.OutsideVersion = true
	}
	facts.Result = signature.NormalizeJSON(failed.ErrorJson, errorContext)

	if len(credentialNames) > 0 && permissions["credentials.read"] {
		rows, err := q.ListCredentialExpiries(ctx, store.ListCredentialExpiriesParams{OrgID: orgID, Names: credentialNames})
		if err != nil {
			return Investigation{}, err
		}
		for _, row := range rows {
			if row.ExpiresAt != nil && !row.ExpiresAt.After(facts.FailedAt) && earlier(row.ExpiresAt, facts.ExpiredAt) {
				facts.ExpiredCredential, facts.ExpiredAt = signature.ScrubSecretShapes(row.Name), row.ExpiresAt
			}
		}
	}

	workflowID := pgtype.Text{String: run.WorkflowID, Valid: run.WorkflowID != ""}
	if workflowID.Valid && facts.Version > 0 {
		successes, err := q.ListRecentWorkflowSuccesses(ctx, store.ListRecentWorkflowSuccessesParams{
			OrgID: orgID, WorkflowID: workflowID, Before: run.CreatedAt, RunLimit: historyRunLimit,
		})
		if err != nil {
			return Investigation{}, err
		}
		for _, success := range successes {
			if success.WorkflowVersionID == run.WorkflowVersionID {
				facts.SameVersionSuccess = success.ID
				break
			}
			if facts.OlderSuccess == "" && success.Version > 0 && int(success.Version) < facts.Version {
				facts.OlderSuccess, facts.OlderVersion = success.ID, int(success.Version)
			}
		}
	}

	if workflowID.Valid && facts.Result.Category == "network_timeout" {
		since, until := facts.FailedAt.Add(-stepWindow), facts.FailedAt
		if run.CreatedAt != nil && run.CreatedAt.After(until) {
			until = *run.CreatedAt
		}
		outcomes, err := q.ListRecentStepOutcomes(ctx, store.ListRecentStepOutcomesParams{
			OrgID: orgID, WorkflowID: workflowID, Since: &since, Until: &until,
			RunLimit: historyRunLimit, NodeID: failed.NodeID,
		})
		if err != nil {
			return Investigation{}, err
		}
		facts.StepRuns = len(outcomes)
		for _, outcome := range outcomes {
			if outcome.Status == "failed" && signature.NormalizeJSON(outcome.ErrorJson, errorContext).Signature == facts.Result.Signature {
				facts.StepSameFailures++
			}
		}
	}

	_ = json.Unmarshal(run.UpstreamTags, &facts.UpstreamTags)
	if facts.UpstreamVisible && len(facts.UpstreamTags) > 0 {
		rows, err := q.ListWatchedUpstreamReadings(ctx, store.ListWatchedUpstreamReadingsParams{OrgID: orgID, Names: facts.UpstreamTags})
		if err != nil {
			return Investigation{}, err
		}
		for _, row := range rows {
			// A poll error keeps the previous degraded flag, which no longer describes anything.
			facts.Upstream = append(facts.Upstream, upstreamReading{
				Name: row.Name, Successful: row.LastStatus.Valid && !row.LastErrorReason.Valid,
				Degraded: row.LastDegraded, CheckedAt: row.LastCheckedAt,
				Interval: time.Duration(row.CheckIntervalSeconds) * time.Second,
			})
		}
	}

	if permissions["dlq.read"] {
		id, err := q.FindOpenDeadLetterForNode(ctx, store.FindOpenDeadLetterForNodeParams{
			OrgID: orgID, RunID: runID, NodeID: failed.NodeID,
		})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return Investigation{}, err
		}
		facts.DeadLetterID = id
	}
	// The same permissions the Recover queue requires before it offers Suggest fix.
	facts.CanFix = permissions["ai.write"] && permissions["recovery.write"] && permissions["workflows.write"] &&
		permissions["dlq.replay"] && permissions["runs.start"]
	return evaluateInvestigation(facts), nil
}

// failureTime never falls back to now: a step without a finish time failed no later than its run started.
func failureTime(finishedAt, runCreatedAt *time.Time, now time.Time) time.Time {
	switch {
	case finishedAt != nil:
		return finishedAt.UTC()
	case runCreatedAt != nil:
		return runCreatedAt.UTC()
	default:
		return now
	}
}

func earlier(left, right *time.Time) bool {
	return left != nil && (right == nil || left.Before(*right))
}

// snapshotWorkflow parses the workflow the run executed, or nil when the snapshot is unreadable.
func snapshotWorkflow(inputJSON []byte) *domain.Workflow {
	var input struct {
		Workflow json.RawMessage `json:"workflow"`
	}
	if json.Unmarshal(inputJSON, &input) != nil || len(input.Workflow) == 0 {
		return nil
	}
	workflow, _ := domain.Parse(input.Workflow)
	return workflow
}
