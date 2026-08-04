package httpapi

import (
	"context"
	"encoding/json"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/store"
)

const autoHealingAutonomyFactLimit = 200

// assessAutoHealingRows resolves all tenant-scoped facts in one bounded query
// and derives the same fail-closed authority explanation as the Node baseline.
// The projection explains policy only; decide/apply remains operator-owned.
func assessAutoHealingRows(ctx context.Context, q *store.Queries, orgID string, rows []store.AutoHealingRun) ([]domain.TechnicalRecoveryAutonomyAssessment, error) {
	if len(rows) == 0 {
		return []domain.TechnicalRecoveryAutonomyAssessment{}, nil
	}
	ids := make([]string, 0, min(len(rows), autoHealingAutonomyFactLimit))
	seen := make(map[string]struct{}, cap(ids))
	for _, row := range rows {
		if row.ID == "" || len(ids) == autoHealingAutonomyFactLimit {
			continue
		}
		if _, duplicate := seen[row.ID]; duplicate {
			continue
		}
		seen[row.ID] = struct{}{}
		ids = append(ids, row.ID)
	}
	facts, err := q.ListAutoHealingAutonomyFacts(ctx, store.ListAutoHealingAutonomyFactsParams{
		OrgID: orgID, Ids: ids,
	})
	if err != nil {
		return nil, err
	}
	factByID := make(map[string]store.ListAutoHealingAutonomyFactsRow, len(facts))
	for _, fact := range facts {
		factByID[fact.AutoHealingID] = fact
	}

	assessments := make([]domain.TechnicalRecoveryAutonomyAssessment, 0, len(rows))
	for _, row := range rows {
		fact := factByID[row.ID]
		var original *domain.TechnicalRecoveryWorkflow
		if fact.ContextFound {
			original, _ = domain.ParseTechnicalRecoveryWorkflow(fact.WorkflowJson)
		}
		candidate, candidateOK := domain.ParseTechnicalRecoveryWorkflow(row.ProposedPatchJson)
		originalOK := original != nil
		var contract *domain.RecoveryContract
		if originalOK && original.Recovery != nil {
			contract = original.Recovery.Contract
		}
		repairClass := ""
		if originalOK && candidateOK {
			repairClass = domain.ClassifyTechnicalRecoveryRepair(original, candidate, fact.NodeID)
		}
		failure := domain.TechnicalFailureTerminal
		if fact.ContextFound && autoHealingErrorCode(fact.ErrorJson) == "worker_stalled" {
			failure = domain.TechnicalFailureStalled
		}
		priorVerified := int(max(fact.PriorVerifiedRecoveries, 0))
		evidence := ""
		if row.ValidationEvidenceLevel.Valid {
			evidence = row.ValidationEvidenceLevel.String
		}
		assessments = append(assessments, domain.EvaluateTechnicalRecoveryAutonomy(domain.TechnicalRecoveryAutonomyInput{
			Contract: contract, Failure: failure, RepairClass: repairClass,
			ValidationEvidenceLevel: evidence, PriorVerifiedRecoveries: priorVerified,
			AffectedExecutions: 1, RollbackReady: originalOK && candidateOK,
		}))
	}
	return assessments, nil
}

func autoHealingErrorCode(raw json.RawMessage) string {
	var payload struct {
		Code string `json:"code"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return ""
	}
	return payload.Code
}
