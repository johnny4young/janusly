// Workflow deployments (baseline/canary rollouts) — the durable traffic
// split implements the contract's workflowRolloutsRepo: immutable
// version snapshots validated at create (canary must be the LATEST saved
// version, strictly newer than baseline, with byte-identical external
// trigger contracts), a deterministic sha256 bucket for assignment, and
// the durable deployment choice captured on the run at start. The V2
// recovery-contract gate refuses a rollout without a PASSED dataset
// qualification receipt for the exact version pair.
package engine

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/store"
)

// Rollout bounds (reference constants, verbatim).
const (
	WorkflowRolloutTrafficMin     = 1
	WorkflowRolloutTrafficMax     = 50
	WorkflowRolloutSampleMin      = 5
	WorkflowRolloutSampleMax      = 100
	WorkflowRolloutSuccessRateMin = 1
	WorkflowRolloutSuccessRateMax = 100
)

// RecoveryQualificationDatasetVersion pins the immutable dataset the
// qualification receipts reference.
const RecoveryQualificationDatasetVersion = "1"

// externalTriggerTypes: rollout variants must agree on these nodes
// byte-for-byte or external deliveries would change contract mid-split.
var externalTriggerTypes = map[string]bool{
	"schedule": true, "email_received": true, "file_dropped": true, "mcp_server_event": true,
}

// stableJSON renders a value with sorted object keys — the contract's
// stableJson, so both implementations agree on the trigger contract.
func stableJSON(value any) string {
	switch typed := value.(type) {
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			parts = append(parts, stableJSON(item))
		}
		return "[" + strings.Join(parts, ",") + "]"
	case map[string]any:
		keys := slices.Sorted(maps.Keys(typed))
		parts := make([]string, 0, len(keys))
		for _, key := range keys {
			keyJSON, _ := json.Marshal(key)
			parts = append(parts, string(keyJSON)+":"+stableJSON(typed[key]))
		}
		return "{" + strings.Join(parts, ",") + "}"
	default:
		raw, err := json.Marshal(value)
		if err != nil {
			return "null"
		}
		return string(raw)
	}
}

func externalTriggerContract(wf *domain.Workflow) string {
	triggers := make([]any, 0)
	nodes := make([]domain.Node, 0, len(wf.Nodes))
	nodes = append(nodes, wf.Nodes...)
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].ID < nodes[j].ID })
	for _, node := range nodes {
		if !externalTriggerTypes[node.Type] {
			continue
		}
		config := map[string]any{}
		maps.Copy(config, node.Config)
		triggers = append(triggers, map[string]any{"id": node.ID, "type": node.Type, "config": config})
	}
	return stableJSON(triggers)
}

// HaveCompatibleWorkflowRolloutTriggers requires identical external
// trigger ids, types, and configs across variants.
func HaveCompatibleWorkflowRolloutTriggers(baseline, canary *domain.Workflow) bool {
	return externalTriggerContract(baseline) == externalTriggerContract(canary)
}

// WorkflowRolloutBucket derives the stable 0..99 assignment bucket from
// an opaque event/run key (sha256 over the JSON pair, first uint32 BE).
func WorkflowRolloutBucket(rolloutID, assignmentKey string) int {
	pair, _ := json.Marshal([]string{rolloutID, assignmentKey})
	digest := sha256.Sum256(pair)
	return int(binary.BigEndian.Uint32(digest[:4]) % 100)
}

// CreateRolloutKind enumerates the create outcomes.
type CreateRolloutKind string

const (
	RolloutCreated               CreateRolloutKind = "created"
	RolloutNotFound              CreateRolloutKind = "not_found"
	RolloutInvalidVersions       CreateRolloutKind = "invalid_versions"
	RolloutCanaryNotLatest       CreateRolloutKind = "canary_not_latest"
	RolloutIncompatibleTriggers  CreateRolloutKind = "incompatible_triggers"
	RolloutQualificationRequired CreateRolloutKind = "recovery_qualification_required"
	RolloutActiveExists          CreateRolloutKind = "active_exists"
)

func validRolloutBound(value, minValue, maxValue int) bool {
	return value >= minValue && value <= maxValue
}

// CreateWorkflowRollout starts one rollout after validating both
// immutable version snapshots inside a parent-locked transaction.
func (e *Engine) CreateWorkflowRollout(ctx context.Context, input struct {
	OrgID, WorkflowID, BaselineVersionID, CanaryVersionID        string
	TrafficPercent, MinimumSampleSize, MinimumSuccessRatePercent int
	CreatedBy                                                    string
}) (CreateRolloutKind, *store.WorkflowRollout, error) {
	if !validRolloutBound(input.TrafficPercent, WorkflowRolloutTrafficMin, WorkflowRolloutTrafficMax) ||
		!validRolloutBound(input.MinimumSampleSize, WorkflowRolloutSampleMin, WorkflowRolloutSampleMax) ||
		!validRolloutBound(input.MinimumSuccessRatePercent, WorkflowRolloutSuccessRateMin, WorkflowRolloutSuccessRateMax) ||
		input.BaselineVersionID == input.CanaryVersionID {
		return RolloutInvalidVersions, nil, nil
	}
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return "", nil, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(e.wrapTx(tx))

	// Version writes and soft delete take this same lock first, so an
	// active rollout can never appear concurrently with either.
	if _, err := q.LockWorkflowForRollout(ctx, store.LockWorkflowForRolloutParams{
		OrgID: input.OrgID, ID: input.WorkflowID,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return RolloutNotFound, nil, nil
		}
		return "", nil, fmt.Errorf("lock workflow: %w", err)
	}
	versions, err := q.ListWorkflowVersionsForRollout(ctx, store.ListWorkflowVersionsForRolloutParams{
		OrgID: input.OrgID, WorkflowID: input.WorkflowID,
	})
	if err != nil {
		return "", nil, fmt.Errorf("list versions: %w", err)
	}
	var baseline, canary *store.ListWorkflowVersionsForRolloutRow
	for i := range versions {
		if versions[i].ID == input.BaselineVersionID {
			baseline = &versions[i]
		}
		if versions[i].ID == input.CanaryVersionID {
			canary = &versions[i]
		}
	}
	if baseline == nil || canary == nil || baseline.Version >= canary.Version {
		return RolloutInvalidVersions, nil, nil
	}
	if len(versions) == 0 || versions[0].ID != canary.ID {
		return RolloutCanaryNotLatest, nil, nil
	}
	baselineWorkflow, baselineIssues := domain.Parse(baseline.DagJson)
	canaryWorkflow, canaryIssues := domain.Parse(canary.DagJson)
	if baselineWorkflow == nil || canaryWorkflow == nil || len(baselineIssues) > 0 || len(canaryIssues) > 0 {
		return RolloutInvalidVersions, nil, nil
	}
	if !HaveCompatibleWorkflowRolloutTriggers(baselineWorkflow, canaryWorkflow) {
		return RolloutIncompatibleTriggers, nil, nil
	}
	if _, err := q.FindActiveWorkflowRollout(ctx, store.FindActiveWorkflowRolloutParams{
		OrgID: input.OrgID, WorkflowID: input.WorkflowID,
	}); err == nil {
		return RolloutActiveExists, nil, nil
	}
	// A V2 recovery contract on EITHER side demands a passed dataset
	// qualification receipt for this exact version pair.
	needsQualification := (baselineWorkflow.Recovery != nil && baselineWorkflow.Recovery.Contract != nil &&
		baselineWorkflow.Recovery.Contract.Version == "2") ||
		(canaryWorkflow.Recovery != nil && canaryWorkflow.Recovery.Contract != nil &&
			canaryWorkflow.Recovery.Contract.Version == "2")
	if needsQualification {
		if _, err := q.FindPassedRecoveryQualification(ctx, store.FindPassedRecoveryQualificationParams{
			OrgID: input.OrgID, WorkflowID: input.WorkflowID,
			BaselineVersionID: baseline.ID, CandidateVersionID: canary.ID,
			DatasetVersion: RecoveryQualificationDatasetVersion,
		}); err != nil {
			return RolloutQualificationRequired, nil, nil
		}
	}
	rollout, err := q.InsertWorkflowRollout(ctx, store.InsertWorkflowRolloutParams{
		ID: e.newID(), OrgID: input.OrgID, WorkflowID: input.WorkflowID,
		BaselineVersionID: baseline.ID, CanaryVersionID: canary.ID,
		TrafficPercent:            int32(input.TrafficPercent),
		MinimumSampleSize:         int32(input.MinimumSampleSize),
		MinimumSuccessRatePercent: int32(input.MinimumSuccessRatePercent),
		CreatedBy:                 input.CreatedBy,
	})
	if err != nil {
		// The partial unique (org, workflow) WHERE active makes a
		// concurrent create an active_exists, not an error.
		return RolloutActiveExists, nil, nil //nolint:nilerr // unique-violation → deterministic outcome
	}
	if err := tx.Commit(ctx); err != nil {
		return "", nil, fmt.Errorf("commit: %w", err)
	}
	return RolloutCreated, &rollout, nil
}

// RolloutAssignment is the durable deployment choice for one run/event.
type RolloutAssignment struct {
	Rollout   store.WorkflowRollout
	Variant   string
	VersionID string
	Version   int32
	Workflow  *domain.Workflow
}

// ErrRolloutVersionUnavailable marks a rollout whose assigned version cannot
// run; retrying does not help until the version or the rollout changes.
var ErrRolloutVersionUnavailable = errors.New("workflow_rollout_version_unavailable")

// RolloutVersionUnavailableError names the rollout and version an operator must fix.
type RolloutVersionUnavailableError struct {
	RolloutID, VersionID string
	Version              int32
}

func (e *RolloutVersionUnavailableError) Error() string {
	version := e.VersionID
	if e.Version > 0 {
		version = fmt.Sprintf("v%d (%s)", e.Version, e.VersionID)
	}
	return fmt.Sprintf("workflow_rollout_version_unavailable: rollout %s assigns version %s, which cannot run", e.RolloutID, version)
}

func (e *RolloutVersionUnavailableError) Unwrap() error { return ErrRolloutVersionUnavailable }

// parsedVersion is one version document parsed once per caller-owned cache.
type parsedVersion struct {
	workflow *domain.Workflow
	version  int32
	valid    bool
}

// loadWorkflowVersion reads one org-scoped version, reusing cache when given.
func loadWorkflowVersion(ctx context.Context, q *store.Queries, orgID, workflowID, versionID string, cache map[string]parsedVersion) (parsedVersion, error) {
	key := orgID + "|" + workflowID + "|" + versionID
	if parsed, ok := cache[key]; ok {
		return parsed, nil
	}
	row, err := q.GetWorkflowVersionByID(ctx, store.GetWorkflowVersionByIDParams{
		ID: versionID, OrgID: orgID, WorkflowID: workflowID,
	})
	if err != nil {
		return parsedVersion{}, err
	}
	wf, issues := domain.Parse(row.DagJson)
	parsed := parsedVersion{workflow: wf, version: row.Version, valid: wf != nil && len(issues) == 0}
	if cache != nil {
		cache[key] = parsed
	}
	return parsed, nil
}

// ResolveWorkflowRolloutAssignment resolves the deployment choice while
// the rollout's canary is still the LATEST saved version; nil keeps
// ordinary latest-version behaviour. Deterministic: active buckets by
// (rolloutId, assignmentKey); promoted always canary; finished always
// baseline.
func (e *Engine) ResolveWorkflowRolloutAssignment(ctx context.Context, orgID, workflowID, assignmentKey string) (*RolloutAssignment, error) {
	return e.resolveRolloutAssignment(ctx, orgID, workflowID, assignmentKey, nil)
}

// resolveRolloutAssignment reads the rollout row and the latest version id
// before loading the one document the assignment needs.
func (e *Engine) resolveRolloutAssignment(ctx context.Context, orgID, workflowID, assignmentKey string, cache map[string]parsedVersion) (*RolloutAssignment, error) {
	q := store.New(e.pool)
	rollout, err := q.GetLatestWorkflowRolloutRow(ctx, store.GetLatestWorkflowRolloutRowParams{
		OrgID: orgID, WorkflowID: workflowID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	latest, err := q.GetLatestWorkflowVersionRef(ctx, store.GetLatestWorkflowVersionRefParams{
		OrgID: orgID, WorkflowID: workflowID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil || latest.ID != rollout.CanaryVersionID {
		return nil, err
	}
	variant := "baseline"
	switch rollout.Status {
	case "active":
		if WorkflowRolloutBucket(rollout.ID, assignmentKey) < int(rollout.TrafficPercent) {
			variant = "canary"
		}
	case "promoted":
		variant = "canary"
	}
	versionID := rollout.BaselineVersionID
	if variant == "canary" {
		versionID = rollout.CanaryVersionID
	}
	parsed, err := loadWorkflowVersion(ctx, q, orgID, workflowID, versionID, cache)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if err != nil || !parsed.valid {
		return nil, &RolloutVersionUnavailableError{RolloutID: rollout.ID, VersionID: versionID, Version: parsed.version}
	}
	return &RolloutAssignment{
		Rollout: rollout, Variant: variant,
		VersionID: versionID, Version: parsed.version, Workflow: parsed.workflow,
	}, nil
}

// FinishRolloutKind enumerates the operator-decision outcomes.
type FinishRolloutKind string

const (
	RolloutFinishUpdated  FinishRolloutKind = "updated"
	RolloutFinishNotFound FinishRolloutKind = "not_found"
	RolloutFinishInactive FinishRolloutKind = "not_active"
)

// FinishWorkflowRollout promotes the canary or returns all traffic to
// baseline with a CAS on the active status.
func (e *Engine) FinishWorkflowRollout(ctx context.Context, orgID, workflowID, rolloutID, decision, reason string) (FinishRolloutKind, *store.WorkflowRollout, error) {
	q := store.New(e.pool)
	if _, err := q.GetWorkflowRolloutRow(ctx, store.GetWorkflowRolloutRowParams{
		ID: rolloutID, OrgID: orgID, WorkflowID: workflowID,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return RolloutFinishNotFound, nil, nil
		}
		return "", nil, err
	}
	newStatus := "rolled_back"
	if decision == "promote" {
		newStatus = "promoted"
	}
	trimmed := strings.TrimSpace(reason)
	if len(trimmed) > 500 {
		trimmed = trimmed[:500]
	}
	if trimmed == "" {
		trimmed = "operator_rollback"
	}
	updated, err := q.FinishWorkflowRolloutCAS(ctx, store.FinishWorkflowRolloutCASParams{
		ID: rolloutID, OrgID: orgID, WorkflowID: workflowID,
		NewStatus: newStatus,
		Reason:    pgtype.Text{String: trimmed, Valid: true},
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return RolloutFinishInactive, nil, nil
		}
		return "", nil, err
	}
	return RolloutFinishUpdated, &updated, nil
}
