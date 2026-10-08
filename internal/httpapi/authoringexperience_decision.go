package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"reflect"
	"strings"
	"unicode/utf8"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/authoring"
	"github.com/johnny4young/janusly/internal/config"
)

func init() { audit.RegisterRuntimeAction("authoring.experience.decision") }

// This receipt is provenance, not approval, verified effects or Save/Run
// authority. DraftID preserves the reviewed copy's identity during revalidation.
type experienceWorkflowDecision struct {
	authoring.DecisionReceipt
	OutcomeEvidence string `json:"outcomeEvidence"`
	DraftID         string `json:"draftId,omitempty"`
}

type experienceProposalAttempt struct {
	Wire        map[string]any
	Decision    *experienceWorkflowDecision
	Failure     *opResult
	GuardReason string
}

func validExperienceWireID(value string) bool {
	return value != "" && len(value) <= 128 && utf8.ValidString(value) && strings.TrimSpace(value) == value && !strings.ContainsAny(value, "\x00\r\n\t")
}

func decodeExperienceEdits(raw json.RawMessage) ([]authoring.DescriptiveEdit, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	if len(raw) > 1024 || !utf8.Valid(raw) {
		return nil, authoring.ErrExperienceBriefInvalid
	}
	var entries []json.RawMessage
	if json.Unmarshal(raw, &entries) != nil || entries == nil || len(entries) > 1 {
		return nil, authoring.ErrExperienceBriefInvalid
	}
	var edits []authoring.DescriptiveEdit
	for _, entry := range entries {
		var edit authoring.DescriptiveEdit
		if decodeExperienceObject(entry, &edit, []string{"field", "value"}) != nil || !validExperienceWireID(edit.Field) || len(edit.Field) > 64 || len(edit.Value) > 200 || strings.TrimSpace(edit.Value) == "" || strings.ContainsRune(edit.Value, '\x00') {
			return nil, authoring.ErrExperienceBriefInvalid
		}
		edits = append(edits, edit)
	}
	return edits, nil
}

func decodeExperienceProposalFields(editsRaw, receiptRaw json.RawMessage) ([]authoring.DescriptiveEdit, *experienceWorkflowDecision, error) {
	edits, err := decodeExperienceEdits(editsRaw)
	if err != nil || len(receiptRaw) == 0 {
		return edits, nil, err
	}
	keys := []string{"provider", "mode", "reason", "policyVersion", "contextRevision", "catalogVersion", "source", "edits", "truncated", "outcomeEvidence", "draftId"}
	var fields map[string]json.RawMessage
	if len(receiptRaw) > authoring.MaxDecisionResultBytes || decodeExperienceObject(receiptRaw, &fields, keys) != nil {
		return nil, nil, authoring.ErrExperienceBriefInvalid
	}
	for _, key := range keys {
		if key != "edits" && len(fields[key]) == 0 {
			return nil, nil, authoring.ErrExperienceBriefInvalid
		}
	}
	var receipt experienceWorkflowDecision
	if decodeStrictAuthoringObject(receiptRaw, &receipt) != nil || receipt.Provider != authoring.DecisionRulesProvider || receipt.PolicyVersion != authoring.AuthoringExperiencePolicyVersion || receipt.OutcomeEvidence != "unknown" || receipt.Truncated || !validExperienceWireID(receipt.ContextRevision) || !validExperienceWireID(receipt.CatalogVersion) || !validExperienceWireID(receipt.DraftID) {
		return nil, nil, authoring.ErrExperienceBriefInvalid
	}
	isReuse := receipt.Mode == authoring.DecisionReuse && receipt.Reason == authoring.DecisionExactMatch
	isAdapt := receipt.Mode == authoring.DecisionAdapt && receipt.Reason == authoring.DecisionDescriptiveAdapt
	if !isReuse && !isAdapt {
		return nil, nil, authoring.ErrExperienceBriefInvalid
	}
	var source authoring.ExperienceReference
	if decodeExperienceObject(fields["source"], &source, []string{"candidateId", "workflowId", "versionId", "version"}) != nil || !validExperienceWireID(source.CandidateID) || !validExperienceWireID(source.WorkflowID) || !validExperienceWireID(source.VersionID) || source.Version < 1 || source.WorkflowID == receipt.DraftID {
		return nil, nil, authoring.ErrExperienceBriefInvalid
	}
	receipt.Source = &source
	receipt.Edits, err = decodeExperienceEdits(fields["edits"])
	if err != nil || (receipt.Mode == authoring.DecisionReuse && len(receipt.Edits) != 0) || (receipt.Mode == authoring.DecisionAdapt && (len(receipt.Edits) != 1 || receipt.Edits[0].Field != "workflow_name")) {
		return nil, nil, authoring.ErrExperienceBriefInvalid
	}
	// Canonical encoding can expand HTML and Unicode separators. Bound the
	// receipt we retain and later echo, not only its original wire bytes.
	canonical, err := json.Marshal(receipt)
	if err != nil || len(canonical) > authoring.MaxDecisionResultBytes {
		return nil, nil, authoring.ErrExperienceBriefInvalid
	}
	return edits, &receipt, nil
}

func experienceContextRevision(rc v1Request, request workflowProposalRequest, brief authoring.IntentBrief, catalogVersion string) string {
	// No matching hash or canvas content is copied into telemetry. Including
	// identity and the comparison snapshot fences replay across authoring contexts.
	// Layout-only `ui` positions are excluded: dragging a node is not a semantic
	// canvas revision, so it must not silently invalidate a reviewed receipt.
	comparison := request.CurrentWorkflow
	if _, present := comparison["ui"]; present {
		comparison = maps.Clone(comparison)
		delete(comparison, "ui")
	}
	raw, _ := json.Marshal(struct {
		OrganizationID, UserID, CatalogVersion string
		Brief                                  authoring.IntentBrief
		Edits                                  []authoring.DescriptiveEdit
		CurrentWorkflow                        map[string]any
	}{rc.orgID, rc.userID, catalogVersion, brief, request.ExperienceEdits, comparison})
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func guardedExperienceAttempt(reason string) experienceProposalAttempt {
	wire := authoring.GuardedIncompleteWorkflow()
	wire["mode"] = "fallback"
	return experienceProposalAttempt{Wire: wire, GuardReason: reason}
}

func (s *V1Server) auditExperienceDecision(ctx context.Context, rc v1Request, receipt *authoring.DecisionReceipt, reason string) {
	metadata := map[string]any{"stage": string(s.authoringExperienceMode), "policyVersion": authoring.AuthoringExperiencePolicyVersion, "decisionModelCallCount": 0, "outcomeEvidence": "unknown"}
	if receipt == nil {
		metadata["decisionMode"] = "unavailable"
		metadata["reason"] = reason
	} else {
		metadata["decisionMode"] = string(receipt.Mode)
		metadata["reason"] = string(receipt.Reason)
		metadata["truncated"] = receipt.Truncated
		metadata["wouldRequestGeneration"] = receipt.Mode == authoring.DecisionGenerate && receipt.Reason == authoring.DecisionNoMatch
		metadata["canonicalRecipeRequested"] = receipt.Mode == authoring.DecisionGenerate && receipt.Reason == authoring.DecisionCanonicalRecipe
	}
	s.audit.Write(ctx, s.pool, rc.authContext, "authoring.experience.decision", audit.Options{TargetType: "authoring_experience", Metadata: metadata})
}

func (s *V1Server) experienceProposal(r *http.Request, rc v1Request, request workflowProposalRequest, compiled authoring.BriefCompilation, catalog authoring.Catalog, prompt string) experienceProposalAttempt {
	if request.ExperienceReceipt != nil && (s.authoringExperienceMode != config.AuthoringExperienceReview || !s.authoringExperienceEnabled) {
		failure := experienceError(authoring.ErrExperienceDisabled)
		return experienceProposalAttempt{Failure: &failure}
	}
	if !s.authoringExperienceEnabled || s.authoringExperienceMode == config.AuthoringExperienceOff {
		return experienceProposalAttempt{}
	}
	if err := r.Context().Err(); err != nil {
		failure := opError(http.StatusRequestTimeout, "authoring_request_cancelled", "Authoring request cancelled", nil)
		return experienceProposalAttempt{Failure: &failure}
	}
	if denied := s.experiencePermissions(r, rc); denied != nil {
		if request.ExperienceReceipt != nil {
			return experienceProposalAttempt{Failure: denied}
		}
		return experienceProposalAttempt{}
	}
	if receipt := request.ExperienceReceipt; receipt != nil && (receipt.CatalogVersion != catalog.Version || (request.CatalogVersion != "" && request.CatalogVersion != catalog.Version)) {
		// A receipt reviewed against another capability snapshot is stale.
		// Refuse it without reading sources or drafting a replacement.
		return s.experienceAttemptError(r, rc, request, authoring.ErrExperienceSourceUnavailable)
	}
	stage, cancel := context.WithTimeout(r.Context(), authoring.DecisionStageTimeout)
	defer cancel()
	input := authoring.DecisionRequest{OrganizationID: rc.orgID, ContextRevision: experienceContextRevision(rc, request, compiled.Brief, catalog.Version), CatalogVersion: catalog.Version, Brief: compiled.Brief, Complete: compiled.Complete, CanonicalRecipe: authoring.IsCanonicalPagerDutyWorkflow(prompt, &compiled.Brief), Edits: request.ExperienceEdits}
	selection, err := s.experienceReader.Decide(stage, input, catalog)
	if stage.Err() != nil {
		err = stage.Err()
	}
	if err == nil {
		projection := selection.Request
		verified, checkErr := authoring.ProposeDecision(stage, authoring.RulesProvider{}, projection)
		if checkErr != nil || !authoring.SameDecisionReceipt(verified, selection.Receipt) || projection.OrganizationID != input.OrganizationID || projection.ContextRevision != input.ContextRevision || projection.CatalogVersion != input.CatalogVersion || projection.Complete != input.Complete || projection.CanonicalRecipe != input.CanonicalRecipe || !projection.Consent || !reflect.DeepEqual(projection.Brief, input.Brief) || !reflect.DeepEqual(projection.Edits, input.Edits) {
			err = authoring.ErrExperienceSourceUnavailable
		}
	}
	if err != nil {
		return s.experienceAttemptError(r, rc, request, err)
	}
	receipt := selection.Receipt
	if s.authoringExperienceMode == config.AuthoringExperienceShadow {
		s.auditExperienceDecision(r.Context(), rc, &receipt, "")
		return experienceProposalAttempt{}
	}
	decision := &experienceWorkflowDecision{DecisionReceipt: receipt, OutcomeEvidence: "unknown"}
	if request.ExperienceReceipt != nil && !authoring.SameDecisionReceipt(request.ExperienceReceipt.DecisionReceipt, receipt) {
		return s.experienceAttemptError(r, rc, request, authoring.ErrExperienceSourceUnavailable)
	}
	attempt := experienceProposalAttempt{Decision: decision}
	switch receipt.Mode {
	case authoring.DecisionReuse, authoring.DecisionAdapt:
		decision.DraftID = s.newID()
		if request.ExperienceReceipt != nil {
			decision.DraftID = request.ExperienceReceipt.DraftID
		}
		draft, resolveErr := s.experienceReader.Resolve(stage, input, receipt, catalog, decision.DraftID)
		if stage.Err() != nil {
			resolveErr = stage.Err()
		}
		if resolveErr != nil {
			return s.experienceAttemptError(r, rc, request, resolveErr)
		}
		if len(draft) > 2*1024*1024 || json.Unmarshal(draft, &attempt.Wire) != nil || attempt.Wire == nil {
			return s.experienceAttemptError(r, rc, request, authoring.ErrExperienceSourceIncompatible)
		}
		attempt.Wire["mode"] = "fallback"
	case authoring.DecisionEscalate:
		attempt = guardedExperienceAttempt("authoring_experience_review_required")
		attempt.Decision = decision
	case authoring.DecisionGenerate:
		// Classification does not grant admission. The existing explicit
		// generation/recipe ladder keeps all budget, rate and provider gates.
	}
	if stage.Err() != nil {
		return s.experienceAttemptError(r, rc, request, stage.Err())
	}
	s.auditExperienceDecision(r.Context(), rc, &receipt, "")
	return attempt
}

func (s *V1Server) experienceAttemptError(r *http.Request, rc v1Request, request workflowProposalRequest, err error) experienceProposalAttempt {
	if r.Context().Err() != nil {
		failure := opError(http.StatusRequestTimeout, "authoring_request_cancelled", "Authoring request cancelled", nil)
		return experienceProposalAttempt{Failure: &failure}
	}
	reason := "authoring_experience_unavailable"
	if errors.Is(err, context.DeadlineExceeded) {
		reason = "authoring_experience_timeout"
	} else if errors.Is(err, authoring.ErrExperienceSourceUnavailable) || errors.Is(err, authoring.ErrExperienceSourceIncompatible) {
		reason = "authoring_experience_source_changed"
	} else if errors.Is(err, authoring.ErrExperienceDisabled) {
		if request.ExperienceReceipt == nil {
			return experienceProposalAttempt{} // ordinary authoring without approved memory
		}
		failure := experienceError(err)
		return experienceProposalAttempt{Failure: &failure}
	}
	s.auditExperienceDecision(r.Context(), rc, nil, reason)
	if s.authoringExperienceMode == config.AuthoringExperienceShadow {
		return experienceProposalAttempt{}
	}
	if request.ExperienceReceipt == nil && (reason == "authoring_experience_timeout" || reason == "authoring_experience_unavailable") {
		// An initial optional lookup failure preserves the one existing,
		// independently admitted generation ladder. Revalidating a reviewed
		// source is different: it must never request a replacement draft.
		return experienceProposalAttempt{}
	}
	return guardedExperienceAttempt(reason)
}

// Keep legacy member recovery unchanged. Only the new experience extension
// requires exact root names and rejects duplicates before decoding its value.
func validateExperienceProposalMemberNames(raw json.RawMessage) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return authoring.ErrExperienceBriefInvalid
	}
	seen := map[string]bool{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return authoring.ErrExperienceBriefInvalid
		}
		key, ok := token.(string)
		if !ok {
			return authoring.ErrExperienceBriefInvalid
		}
		for _, name := range []string{"experienceEdits", "experienceReceipt"} {
			if strings.EqualFold(key, name) {
				if key != name || seen[name] {
					return authoring.ErrExperienceBriefInvalid
				}
				seen[name] = true
			}
		}
		var value json.RawMessage
		if decoder.Decode(&value) != nil {
			return authoring.ErrExperienceBriefInvalid
		}
	}
	return nil
}
