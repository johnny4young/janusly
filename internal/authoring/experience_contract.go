package authoring

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	AuthoringExperiencePolicyVersion = "authoring-experience-v1"
	MaxDecisionRequestBytes          = 8 * 1024
	MaxDecisionResultBytes           = 4 * 1024
	MaxExperienceCandidates          = 5
	DecisionStageTimeout             = 200 * time.Millisecond
)

type DecisionProviderKind string

const (
	DecisionRulesProvider   DecisionProviderKind = "rules"
	DecisionFixtureProvider DecisionProviderKind = "fixture"
)

type DecisionMode string

const (
	DecisionReuse    DecisionMode = "REUSE"
	DecisionAdapt    DecisionMode = "ADAPT"
	DecisionGenerate DecisionMode = "GENERATE"
	DecisionEscalate DecisionMode = "ESCALATE"
)

type DecisionReason string

const (
	DecisionExactMatch            DecisionReason = "exact_match"
	DecisionDescriptiveAdapt      DecisionReason = "descriptive_adaptation"
	DecisionNoMatch               DecisionReason = "no_exact_match"
	DecisionCanonicalRecipe       DecisionReason = "canonical_recipe"
	DecisionIncompleteIntent      DecisionReason = "incomplete_intent"
	DecisionConsentUnavailable    DecisionReason = "consent_unavailable"
	DecisionAmbiguous             DecisionReason = "ambiguous_match"
	DecisionCandidatesTruncated   DecisionReason = "candidates_truncated"
	DecisionUnsupportedAdaptation DecisionReason = "unsupported_adaptation"
)

// DescriptiveEdit is a closed review-only delta, never a JSON patch or a tool
// instruction. Only workflow_name is supported; semantic edits require review.
type DescriptiveEdit struct {
	Field string `json:"field"`
	Value string `json:"value"`
}

// ExperienceCandidate is a caller-owned eligibility projection of an exact
// saved version. These facts must come from scoped readers, not a provider or
// memory metadata. A receipt still requires re-reading the source before use.
type ExperienceCandidate struct {
	ID               string     `json:"id"`
	OrganizationID   string     `json:"organizationId"`
	WorkflowID       string     `json:"workflowId"`
	VersionID        string     `json:"versionId"`
	Version          int        `json:"version"`
	BriefKey         string     `json:"briefKey"`
	PolicyVersion    string     `json:"policyVersion"`
	RegisteredAt     time.Time  `json:"registeredAt"`
	VersionCreatedAt time.Time  `json:"versionCreatedAt"`
	RetainUntil      time.Time  `json:"retainUntil"`
	RevokedAt        *time.Time `json:"revokedAt,omitempty"`
	Deleted          bool       `json:"deleted"`
	Readable         bool       `json:"readable"`
	Compatible       bool       `json:"compatible"`
}

// DecisionRequest deliberately contains no DAG, credential values, completion
// text, writer, resolver or execution callbacks. AsOf fences historical replay;
// production callers supply the current instant and their context revision.
type DecisionRequest struct {
	OrganizationID  string                `json:"organizationId"`
	ContextRevision string                `json:"contextRevision"`
	CatalogVersion  string                `json:"catalogVersion"`
	Brief           IntentBrief           `json:"brief"`
	Complete        bool                  `json:"complete"`
	Consent         bool                  `json:"consent"`
	AsOf            time.Time             `json:"asOf"`
	CanonicalRecipe bool                  `json:"canonicalRecipe"`
	Candidates      []ExperienceCandidate `json:"candidates"`
	Truncated       bool                  `json:"truncated"`
	Edits           []DescriptiveEdit     `json:"edits,omitempty"`
}

// DecisionProposal is untrusted. Only ValidateDecision can convert its
// references into a bounded policy receipt. A mode never grants AI admission.
type DecisionProposal struct {
	Mode            DecisionMode      `json:"mode"`
	Reason          DecisionReason    `json:"reason"`
	ContextRevision string            `json:"contextRevision"`
	CatalogVersion  string            `json:"catalogVersion"`
	CandidateID     string            `json:"candidateId,omitempty"`
	VersionID       string            `json:"versionId,omitempty"`
	Edits           []DescriptiveEdit `json:"edits,omitempty"`
}

type ExperienceReference struct {
	CandidateID string `json:"candidateId"`
	WorkflowID  string `json:"workflowId"`
	VersionID   string `json:"versionId"`
	Version     int    `json:"version"`
}

// DecisionReceipt records deterministic policy acceptance, not model
// confidence, observed business success or permission to Apply/Save/Run.
type DecisionReceipt struct {
	Provider        DecisionProviderKind `json:"provider,omitempty"`
	Mode            DecisionMode         `json:"mode"`
	Reason          DecisionReason       `json:"reason"`
	PolicyVersion   string               `json:"policyVersion"`
	ContextRevision string               `json:"contextRevision"`
	CatalogVersion  string               `json:"catalogVersion"`
	Source          *ExperienceReference `json:"source,omitempty"`
	Edits           []DescriptiveEdit    `json:"edits,omitempty"`
	Truncated       bool                 `json:"truncated"`
}

// Implementations are synchronous local decision mechanisms and must honor
// cancellation. This interface intentionally offers no external I/O authority.
type DecisionProvider interface {
	Kind() DecisionProviderKind
	Propose(context.Context, DecisionRequest) (DecisionProposal, error)
}

var (
	errDecisionRequest  = errors.New("invalid authoring decision request")
	errDecisionProposal = errors.New("invalid authoring decision proposal")
)

// CanonicalExperienceKey preserves all ordered fields and literal machine
// identities without inference, case folding, fuzzy matching or truncation.
// The key is internal matching data, never an audit or metric dimension.
func CanonicalExperienceKey(brief IntentBrief) (string, error) {
	raw, err := json.Marshal(brief)
	if err != nil || len(raw) > MaxDecisionRequestBytes || !validDecisionBrief(brief) {
		return "", errDecisionRequest
	}
	hash := sha256.Sum256(raw)
	return hex.EncodeToString(hash[:]), nil
}

// ProposeDecision gives the provider its own projection and enforces policy
// against a separate snapshot. It never starts a second path after cancellation.
func ProposeDecision(ctx context.Context, provider DecisionProvider, request DecisionRequest) (DecisionReceipt, error) {
	if err := ctx.Err(); err != nil {
		return DecisionReceipt{}, err
	}
	if provider == nil || validateDecisionRequest(request) != nil {
		return DecisionReceipt{}, errDecisionRequest
	}
	kind := provider.Kind()
	if kind != DecisionRulesProvider && kind != DecisionFixtureProvider {
		return DecisionReceipt{}, errDecisionProposal
	}
	owned := cloneDecisionRequest(request)
	stage, cancel := context.WithTimeout(ctx, DecisionStageTimeout)
	defer cancel()
	proposal, err := provider.Propose(stage, cloneDecisionRequest(owned))
	if stage.Err() != nil {
		return DecisionReceipt{}, stage.Err()
	}
	if err != nil {
		return DecisionReceipt{}, err
	}
	receipt, err := ValidateDecision(owned, proposal)
	if err != nil {
		return DecisionReceipt{}, err
	}
	receipt.Provider = kind
	return receipt, nil
}

// sameDecisionReceipt compares receipts by their canonical wire form, so an
// omitted and an empty edit list (which encode identically) remain the same
// receipt after a caller round-trips it through JSON.
func sameDecisionReceipt(a, b DecisionReceipt) bool {
	left, leftErr := json.Marshal(a)
	right, rightErr := json.Marshal(b)
	return leftErr == nil && rightErr == nil && bytes.Equal(left, right)
}

func cloneDecisionRequest(r DecisionRequest) DecisionRequest {
	r.Brief.Inputs = slices.Clone(r.Brief.Inputs)
	r.Brief.ExternalEffects = slices.Clone(r.Brief.ExternalEffects)
	r.Brief.Approvals = slices.Clone(r.Brief.Approvals)
	r.Brief.Examples = slices.Clone(r.Brief.Examples)
	r.Edits = slices.Clone(r.Edits)
	r.Candidates = slices.Clone(r.Candidates)
	for i := range r.Candidates {
		if r.Candidates[i].RevokedAt != nil {
			stamp := *r.Candidates[i].RevokedAt
			r.Candidates[i].RevokedAt = &stamp
		}
	}
	return r
}

// DecodeDecisionProposal accepts exactly one strict, bounded JSON object. It
// does not change the separate workflow JSON recovery policy.
func DecodeDecisionProposal(raw []byte) (DecisionProposal, error) {
	if len(raw) > MaxDecisionResultBytes || !utf8.Valid(raw) || len(bytes.TrimSpace(raw)) == 0 || bytes.TrimSpace(raw)[0] != '{' {
		return DecisionProposal{}, errDecisionProposal
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var proposal DecisionProposal
	if decoder.Decode(&proposal) != nil {
		return DecisionProposal{}, errDecisionProposal
	}
	if decoder.Decode(new(any)) != io.EOF {
		return DecisionProposal{}, errDecisionProposal
	}
	if !validProposalShape(proposal) {
		return DecisionProposal{}, errDecisionProposal
	}
	// "edits":[] and an omitted field are the same proposal; keep one form so
	// the decoded value is stable across an encode/decode round trip.
	if len(proposal.Edits) == 0 {
		proposal.Edits = nil
	}
	return proposal, nil
}

// ValidateDecision is independent of provider preference. It recomputes exact
// matching and admission from the trusted projection before copying references.
// Artifact reads, consent rechecks, binding and readiness remain caller duties.
func ValidateDecision(r DecisionRequest, p DecisionProposal) (DecisionReceipt, error) {
	if validateDecisionRequest(r) != nil {
		return DecisionReceipt{}, errDecisionRequest
	}
	if !validProposalShape(p) || p.ContextRevision != r.ContextRevision || p.CatalogVersion != r.CatalogVersion {
		return DecisionReceipt{}, errDecisionProposal
	}
	mode, reason, selected := requiredDecision(r)
	if p.Mode != mode || p.Reason != reason {
		return DecisionReceipt{}, errDecisionProposal
	}
	receipt := DecisionReceipt{Mode: mode, Reason: reason, PolicyVersion: AuthoringExperiencePolicyVersion, ContextRevision: r.ContextRevision, CatalogVersion: r.CatalogVersion, Truncated: r.Truncated}
	if selected != nil {
		if p.CandidateID != selected.ID || p.VersionID != selected.VersionID || !slices.Equal(p.Edits, r.Edits) {
			return DecisionReceipt{}, errDecisionProposal
		}
		receipt.Source = &ExperienceReference{CandidateID: selected.ID, WorkflowID: selected.WorkflowID, VersionID: selected.VersionID, Version: selected.Version}
		receipt.Edits = slices.Clone(r.Edits)
	} else if p.CandidateID != "" || p.VersionID != "" || len(p.Edits) > 0 {
		return DecisionReceipt{}, errDecisionProposal
	}
	raw, err := json.Marshal(receipt)
	if err != nil || len(raw) > MaxDecisionResultBytes {
		return DecisionReceipt{}, errDecisionProposal
	}
	return receipt, nil
}

func requiredDecision(r DecisionRequest) (DecisionMode, DecisionReason, *ExperienceCandidate) {
	if !r.Complete || strings.TrimSpace(r.Brief.Objective) == "" || strings.TrimSpace(r.Brief.Trigger) == "" || strings.TrimSpace(r.Brief.ExpectedOutcome) == "" {
		return DecisionEscalate, DecisionIncompleteIntent, nil
	}
	if r.CanonicalRecipe {
		return DecisionGenerate, DecisionCanonicalRecipe, nil
	}
	if !r.Consent {
		return DecisionEscalate, DecisionConsentUnavailable, nil
	}
	if !supportedDescriptiveEdits(r.Edits) {
		return DecisionEscalate, DecisionUnsupportedAdaptation, nil
	}
	if r.Truncated {
		return DecisionEscalate, DecisionCandidatesTruncated, nil
	}
	key, _ := CanonicalExperienceKey(r.Brief)
	var selected *ExperienceCandidate
	for i := range r.Candidates {
		candidate := &r.Candidates[i]
		if !eligibleExperience(r, *candidate) || candidate.BriefKey != key {
			continue
		}
		if selected != nil {
			return DecisionEscalate, DecisionAmbiguous, nil
		}
		selected = candidate
	}
	if selected == nil {
		return DecisionGenerate, DecisionNoMatch, nil
	}
	if len(r.Edits) > 0 {
		return DecisionAdapt, DecisionDescriptiveAdapt, selected
	}
	return DecisionReuse, DecisionExactMatch, selected
}

func eligibleExperience(r DecisionRequest, c ExperienceCandidate) bool {
	return c.OrganizationID == r.OrganizationID && c.PolicyVersion == AuthoringExperiencePolicyVersion &&
		c.Readable && c.Compatible && !c.Deleted && !c.RegisteredAt.After(r.AsOf) &&
		!c.VersionCreatedAt.After(r.AsOf) && c.RetainUntil.After(r.AsOf) &&
		(c.RevokedAt == nil || c.RevokedAt.After(r.AsOf))
}

func validateDecisionRequest(r DecisionRequest) error {
	raw, err := json.Marshal(r)
	if err != nil || len(raw) > MaxDecisionRequestBytes || !validDecisionID(r.OrganizationID) || !validDecisionID(r.ContextRevision) || !validDecisionID(r.CatalogVersion) || r.AsOf.IsZero() || !validDecisionBrief(r.Brief) || len(r.Candidates) > MaxExperienceCandidates || len(r.Edits) > 1 {
		return errDecisionRequest
	}
	seen := make(map[string]bool, len(r.Candidates))
	for _, c := range r.Candidates {
		if !validDecisionID(c.ID) || !validDecisionID(c.OrganizationID) || !validDecisionID(c.WorkflowID) || !validDecisionID(c.VersionID) || c.Version < 1 || len(c.BriefKey) != 64 || c.PolicyVersion == "" || len(c.PolicyVersion) > 128 || c.RegisteredAt.IsZero() || c.VersionCreatedAt.IsZero() || c.RetainUntil.IsZero() || seen[c.ID] {
			return errDecisionRequest
		}
		// Keys are lowercase hex as CanonicalExperienceKey emits them; an
		// uppercase projection would validate but silently never match.
		if _, err := hex.DecodeString(c.BriefKey); err != nil || strings.ToLower(c.BriefKey) != c.BriefKey {
			return errDecisionRequest
		}
		seen[c.ID] = true
	}
	return nil
}

func validProposalShape(p DecisionProposal) bool {
	raw, err := json.Marshal(p)
	if err != nil || len(raw) > MaxDecisionResultBytes || !validDecisionID(p.ContextRevision) || !validDecisionID(p.CatalogVersion) || len(p.Edits) > 1 {
		return false
	}
	switch p.Mode {
	case DecisionReuse:
		return p.Reason == DecisionExactMatch && validDecisionID(p.CandidateID) && validDecisionID(p.VersionID) && len(p.Edits) == 0
	case DecisionAdapt:
		return p.Reason == DecisionDescriptiveAdapt && validDecisionID(p.CandidateID) && validDecisionID(p.VersionID) && len(p.Edits) > 0 && supportedDescriptiveEdits(p.Edits)
	case DecisionGenerate:
		return (p.Reason == DecisionNoMatch || p.Reason == DecisionCanonicalRecipe) && p.CandidateID == "" && p.VersionID == "" && len(p.Edits) == 0
	case DecisionEscalate:
		return (p.Reason == DecisionIncompleteIntent || p.Reason == DecisionConsentUnavailable || p.Reason == DecisionAmbiguous || p.Reason == DecisionCandidatesTruncated || p.Reason == DecisionUnsupportedAdaptation) && p.CandidateID == "" && p.VersionID == "" && len(p.Edits) == 0
	default:
		return false
	}
}

func supportedDescriptiveEdits(edits []DescriptiveEdit) bool {
	if len(edits) > 1 {
		return false
	}
	for _, edit := range edits {
		// A workflow name is a single trimmed line without control characters.
		if edit.Field != "workflow_name" || !validDecisionText(edit.Value, 200) || strings.TrimSpace(edit.Value) != edit.Value || edit.Value == "" || strings.ContainsFunc(edit.Value, unicode.IsControl) {
			return false
		}
	}
	return true
}

func validDecisionID(value string) bool {
	return value != "" && len(value) <= 128 && utf8.ValidString(value) && strings.TrimSpace(value) == value && !strings.ContainsAny(value, "\x00\r\n\t")
}
func validDecisionText(value string, maxBytes int) bool {
	return len(value) <= maxBytes && utf8.ValidString(value) && !strings.ContainsRune(value, '\x00')
}
func validDecisionBrief(b IntentBrief) bool {
	if b.Version == "" || !validDecisionText(b.Version, 16) || (b.Language != "en" && b.Language != "es") || !validDecisionText(b.Objective, 4800) || !validDecisionText(b.Trigger, 800) || !validDecisionText(b.ExpectedOutcome, 4800) || !validDecisionText(b.FailurePolicy, 2000) {
		return false
	}
	for _, list := range [][]string{b.Inputs, b.ExternalEffects, b.Approvals, b.Examples} {
		if list == nil || len(list) > maxBriefListEntries {
			return false
		}
		for _, value := range list {
			if !validDecisionText(value, 4800) || strings.TrimSpace(value) == "" {
				return false
			}
		}
	}
	return true
}
