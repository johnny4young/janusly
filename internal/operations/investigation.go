package operations

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/store"
)

// Closed vocabularies the browser translates.
var (
	HypothesisIDs      = []string{"network", "credential", "upstream", "change"}
	HypothesisVerdicts = []string{"validated", "ruled_out", "inconclusive"}
	HypothesisReasons  = []string{
		"no_error", "error_unclassified", "network_dns", "network_unreachable", "network_other_category",
		"credential_missing", "credential_rejected", "credential_expired", "credential_unused", "credential_unproven",
		"upstream_hidden", "upstream_unwatched", "upstream_stale", "upstream_degraded", "upstream_healthy", "upstream_unchecked",
		"change_no_baseline", "change_same_version", "change_new_version",
	}
	EvidenceKinds = []string{"failed_step", "similar_failure", "last_success"}
)

var ErrNoFailedStep = errors.New("run has no failed step")

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

type upstreamState struct {
	Name              string
	Checked, Degraded bool
}

type investigationFacts struct {
	RunID, NodeID, WorkflowName string
	Result                      signature.Result
	HasError                    bool
	Credential                  string
	UsesCredential, ConfigKnown bool
	CredentialExpiredAt         *time.Time
	FailedAt, Now               time.Time
	Version                     int
	LastSuccessRunID            string
	LastSuccessVersion          int
	UpstreamVisible             bool
	UpstreamTags                []string
	Upstream                    []upstreamState
	Similar                     []signature.ClusterSampleRef
	SimilarCount                int
	DeadLetterID                string
	CanFix                      bool
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
	if evidence == nil {
		evidence = []InvestigationEvidence{}
	}
	return Hypothesis{ID: id, Verdict: verdict, Reason: reason, Params: params, Evidence: evidence}
}

func (f investigationFacts) failedStep() InvestigationEvidence {
	return InvestigationEvidence{Kind: "failed_step", RunID: f.RunID, NodeID: f.NodeID}
}

func networkHypothesis(f investigationFacts) Hypothesis {
	switch {
	case !f.HasError:
		return hypothesis("network", "inconclusive", "no_error", nil)
	case f.Result.Category == "network_timeout":
		evidence := []InvestigationEvidence{f.failedStep()}
		for _, sample := range f.Similar {
			if sample.RunID != f.RunID {
				evidence = append(evidence, InvestigationEvidence{Kind: "similar_failure", RunID: sample.RunID})
			}
		}
		reason := "network_unreachable"
		if strings.HasPrefix(f.Result.Signature, "DNS lookup failed") {
			reason = "network_dns"
		}
		params := map[string]any{"signature": f.Result.Signature, "count": max(f.SimilarCount, 1)}
		return hypothesis("network", "validated", reason, params, evidence...)
	case f.Result.Category == "unknown":
		return hypothesis("network", "inconclusive", "error_unclassified", nil, f.failedStep())
	default:
		return hypothesis("network", "ruled_out", "network_other_category",
			map[string]any{"category": f.Result.Category}, f.failedStep())
	}
}

func credentialHypothesis(f investigationFacts) Hypothesis {
	signatureParams := map[string]any{"signature": f.Result.Signature}
	switch {
	case f.Result.Category == "secret_missing":
		return hypothesis("credential", "validated", "credential_missing", signatureParams, f.failedStep())
	case strings.HasPrefix(f.Result.Signature, "HTTP 401 ") || strings.HasPrefix(f.Result.Signature, "HTTP 403 "):
		return hypothesis("credential", "validated", "credential_rejected", signatureParams, f.failedStep())
	case f.CredentialExpiredAt != nil && !f.CredentialExpiredAt.After(f.FailedAt):
		return hypothesis("credential", "validated", "credential_expired", map[string]any{
			"credential": f.Credential, "expiredAt": f.CredentialExpiredAt.UTC().Format(time.RFC3339),
		}, f.failedStep())
	case !f.HasError:
		return hypothesis("credential", "inconclusive", "no_error", nil)
	case f.ConfigKnown && !f.UsesCredential:
		return hypothesis("credential", "ruled_out", "credential_unused", nil, f.failedStep())
	default:
		return hypothesis("credential", "inconclusive", "credential_unproven", nil, f.failedStep())
	}
}

// Upstream status is a current reading, so it says nothing about a failure older than a day.
const upstreamWindow = 24 * time.Hour

func upstreamHypothesis(f investigationFacts) Hypothesis {
	if !f.UpstreamVisible {
		return hypothesis("upstream", "inconclusive", "upstream_hidden", nil)
	}
	if len(f.UpstreamTags) == 0 {
		return hypothesis("upstream", "inconclusive", "upstream_unwatched", nil)
	}
	if f.Now.Sub(f.FailedAt) > upstreamWindow {
		return hypothesis("upstream", "inconclusive", "upstream_stale", nil)
	}
	healthy := []string{}
	for _, source := range f.Upstream {
		if source.Degraded {
			return hypothesis("upstream", "validated", "upstream_degraded", map[string]any{"source": source.Name})
		}
		if source.Checked {
			healthy = append(healthy, source.Name)
		}
	}
	if len(healthy) == 0 {
		return hypothesis("upstream", "inconclusive", "upstream_unchecked", nil)
	}
	return hypothesis("upstream", "ruled_out", "upstream_healthy", map[string]any{"sources": strings.Join(healthy, ", ")})
}

func changeHypothesis(f investigationFacts) Hypothesis {
	if f.LastSuccessRunID == "" {
		return hypothesis("change", "inconclusive", "change_no_baseline", map[string]any{"version": f.Version})
	}
	baseline := InvestigationEvidence{Kind: "last_success", RunID: f.LastSuccessRunID}
	if f.LastSuccessVersion == f.Version {
		return hypothesis("change", "ruled_out", "change_same_version", map[string]any{"version": f.Version}, baseline)
	}
	return hypothesis("change", "validated", "change_new_version",
		map[string]any{"from": f.LastSuccessVersion, "to": f.Version}, baseline)
}

// Investigate gathers tenant-scoped facts for the run's failed step and evaluates every rule.
func (b Builder) Investigate(ctx context.Context, orgID, runID string, permissions map[string]bool) (Investigation, error) {
	now := time.Now().UTC()
	if b.Now != nil {
		now = b.Now().UTC()
	}
	// Unsaved draft runs have no version row, so they have no version to compare.
	var workflowID string
	var inputJSON, tags []byte
	var createdAt *time.Time
	facts := investigationFacts{RunID: runID, Now: now, UpstreamVisible: permissions["upstream.read"]}
	if err := b.Pool.QueryRow(ctx, `
		SELECT r.input_json, r.created_at, coalesce(r.workflow_id, wv.workflow_id, ''), coalesce(wv.version, 0),
		       coalesce(wv.upstream_health_sources, '[]'::jsonb)
		FROM runs r
		LEFT JOIN workflow_versions wv ON wv.id = r.workflow_version_id AND wv.org_id = r.org_id
		WHERE r.org_id = $1 AND r.id = $2`, orgID, runID,
	).Scan(&inputJSON, &createdAt, &workflowID, &facts.Version, &tags); err != nil {
		return Investigation{}, err
	}
	_ = json.Unmarshal(tags, &facts.UpstreamTags)
	nodes, err := store.New(b.Pool).ListRunNodesByRunForOrg(ctx, store.ListRunNodesByRunForOrgParams{RunID: runID, OrgID: orgID})
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
	facts.NodeID, facts.FailedAt = failed.NodeID, now
	if failed.FinishedAt != nil {
		facts.FailedAt = failed.FinishedAt.UTC()
	}
	sample := signature.FailureSample{NodeID: failed.NodeID, ErrorJSON: failed.ErrorJson}
	enrichSample(&sample, inputJSON)
	facts.WorkflowName = signature.ScrubSecretShapes(sample.WorkflowName)
	facts.HasError = len(failed.ErrorJson) > 0 && string(failed.ErrorJson) != "null"
	facts.Result = signature.NormalizeJSON(failed.ErrorJson, signature.Context{
		NodeType: sample.NodeType, NodeID: sample.NodeID, ToolName: sample.ToolName,
	})
	credential, uses, known := nodeCredential(inputJSON, failed.NodeID)
	facts.Credential, facts.UsesCredential, facts.ConfigKnown = signature.ScrubSecretShapes(credential), uses, known
	if credential != "" && permissions["credentials.read"] {
		err := b.Pool.QueryRow(ctx, `SELECT expires_at FROM credentials WHERE org_id = $1 AND name = $2`,
			orgID, credential).Scan(&facts.CredentialExpiredAt)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return Investigation{}, err
		}
	}

	if workflowID != "" && facts.Version > 0 {
		err = b.Pool.QueryRow(ctx, `
			SELECT r.id, wv.version
			FROM runs r
			JOIN workflow_versions wv ON wv.id = r.workflow_version_id AND wv.org_id = r.org_id
			WHERE r.org_id = $1 AND coalesce(r.workflow_id, wv.workflow_id) = $2 AND r.status = 'succeeded'
			  AND r.replay_mode IS NULL AND r.created_at < $3
			ORDER BY r.created_at DESC, r.id DESC
			LIMIT 1`, orgID, workflowID, createdAt).Scan(&facts.LastSuccessRunID, &facts.LastSuccessVersion)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return Investigation{}, err
		}
	}

	if facts.UpstreamVisible && len(facts.UpstreamTags) > 0 {
		rows, err := b.Pool.Query(ctx, `
			SELECT name, last_status IS NOT NULL AND last_error_reason IS NULL, last_degraded
			FROM upstream_health_sources
			WHERE org_id = $1 AND enabled AND name = ANY($2::text[])
			ORDER BY lower(name)`, orgID, facts.UpstreamTags)
		if err != nil {
			return Investigation{}, err
		}
		facts.Upstream, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (upstreamState, error) {
			var state upstreamState
			return state, row.Scan(&state.Name, &state.Checked, &state.Degraded)
		})
		if err != nil {
			return Investigation{}, err
		}
	}

	clusters, _ := b.failureClusters(ctx, orgID, now, permissions["dlq.read"], true, false)
	for _, cluster := range clusters {
		if cluster.Signature == facts.Result.Signature {
			facts.Similar, facts.SimilarCount = cluster.Samples, cluster.Frequency
			break
		}
	}
	if permissions["dlq.read"] {
		err := b.Pool.QueryRow(ctx, `
			SELECT id FROM dead_letters
			WHERE org_id = $1 AND run_id = $2 AND node_id = $3 AND status = 'open'
			ORDER BY created_at DESC, id DESC LIMIT 1`, orgID, runID, failed.NodeID).Scan(&facts.DeadLetterID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return Investigation{}, err
		}
	}
	// The same permissions the Recover queue requires before it offers Suggest fix.
	facts.CanFix = permissions["ai.write"] && permissions["recovery.write"] && permissions["workflows.write"] &&
		permissions["dlq.replay"] && permissions["runs.start"]
	return evaluateInvestigation(facts), nil
}

func earlier(left, right *time.Time) bool {
	return left != nil && (right == nil || left.Before(*right))
}

// nodeCredential reports the named credential, whether any config value references a secret,
// and whether the step's config was found at all.
func nodeCredential(inputJSON []byte, nodeID string) (string, bool, bool) {
	var input struct {
		Workflow struct {
			Nodes []struct {
				ID     string          `json:"id"`
				Config json.RawMessage `json:"config"`
			} `json:"nodes"`
		} `json:"workflow"`
	}
	if json.Unmarshal(inputJSON, &input) != nil {
		return "", false, false
	}
	for _, node := range input.Workflow.Nodes {
		if node.ID != nodeID {
			continue
		}
		var config struct {
			Credential string `json:"credential"`
			Input      struct {
				Credential string `json:"credential"`
			} `json:"input"`
		}
		_ = json.Unmarshal(node.Config, &config)
		name := config.Credential
		if name == "" {
			name = config.Input.Credential
		}
		return name, name != "" || secretTemplate.Match(node.Config), true
	}
	return "", false, false
}
