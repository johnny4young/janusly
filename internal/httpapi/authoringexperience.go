package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"slices"
	"unicode/utf8"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/authoring"
)

func init() {
	audit.RegisterRuntimeAction("authoring.experience.registered")
	audit.RegisterRuntimeAction("authoring.experience.revoked")
}

type authoringExperienceRegisterWire struct {
	WorkflowID json.RawMessage `json:"workflowId"`
	VersionID  json.RawMessage `json:"versionId"`
	Brief      json.RawMessage `json:"brief"`
}

type authoringExperienceRevokeWire struct {
	ID json.RawMessage `json:"id"`
}

// Experience commands admit exact declared field names and no duplicate keys.
// This stricter boundary does not change legacy workflow JSON recovery.
func decodeExperienceObject(raw json.RawMessage, target any, keys []string) error {
	if len(raw) > authoring.MaxDecisionRequestBytes+512 || !utf8.Valid(raw) {
		return authoring.ErrExperienceBriefInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	first, err := decoder.Token()
	if err != nil || first != json.Delim('{') {
		return authoring.ErrExperienceBriefInvalid
	}
	seen := map[string]bool{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return authoring.ErrExperienceBriefInvalid
		}
		key, ok := token.(string)
		if !ok || seen[key] || !slices.Contains(keys, key) {
			return authoring.ErrExperienceBriefInvalid
		}
		seen[key] = true
		var value json.RawMessage
		if decoder.Decode(&value) != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return authoring.ErrExperienceBriefInvalid
		}
	}
	if end, err := decoder.Token(); err != nil || end != json.Delim('}') {
		return authoring.ErrExperienceBriefInvalid
	}
	if _, err := decoder.Token(); err != io.EOF {
		return authoring.ErrExperienceBriefInvalid
	}
	return decodeStrictAuthoringObject(raw, target)
}

func decodeExperienceWire(r *http.Request, target any, keys []string) error {
	var raw json.RawMessage
	if decodeBody(r, &raw) != nil {
		return authoring.ErrExperienceBriefInvalid
	}
	return decodeExperienceObject(raw, target, keys)
}
func (s *V1Server) experiencePermissions(r *http.Request, rc v1Request) *opResult {
	permissions, failed := s.effectivePermissions(r, rc)
	if failed != nil {
		return failed
	}
	if !permissions["ai.write"] || !permissions["workflows.read"] {
		denied := opError(http.StatusForbidden, "server_request_failed", "Forbidden: requires authoring and workflow read permissions", nil)
		return &denied
	}
	return nil
}

func (s *V1Server) experienceRegistry() *authoring.ExperienceRegistry {
	return &authoring.ExperienceRegistry{Pool: s.pool, Enabled: s.authoringExperienceEnabled}
}

func experienceError(err error) opResult {
	switch {
	case errors.Is(err, authoring.ErrExperienceDisabled):
		return opError(http.StatusForbidden, "authoring_experience_disabled", "Authoring experience consent unavailable", nil)
	case errors.Is(err, authoring.ErrExperienceBriefInvalid):
		return opError(http.StatusBadRequest, "authoring_experience_invalid", "Invalid authoring experience request", nil)
	case errors.Is(err, authoring.ErrExperienceSourceUnavailable):
		return opError(http.StatusNotFound, "authoring_experience_source_unavailable", "Authoring experience source unavailable", nil)
	case errors.Is(err, authoring.ErrExperienceSourceIncompatible):
		return opError(http.StatusConflict, "authoring_experience_source_incompatible", "Authoring experience source incompatible", nil)
	default:
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
}

func (s *V1Server) registerAuthoringExperienceCore(r *http.Request, rc v1Request) opResult {
	if denied := s.experiencePermissions(r, rc); denied != nil {
		return *denied
	}
	// Keep disabled registration out of catalog reads as well as provider work.
	registry := s.experienceRegistry()
	if !registry.ProcessEnabled() {
		return experienceError(authoring.ErrExperienceDisabled)
	}
	var wire authoringExperienceRegisterWire
	if decodeExperienceWire(r, &wire, []string{"workflowId", "versionId", "brief"}) != nil {
		return experienceError(authoring.ErrExperienceBriefInvalid)
	}
	input := authoring.ExperienceRegistration{ID: s.newID(), OrganizationID: rc.orgID, ActorID: rc.userID}
	if decodeOptionalAuthoringValue(wire.WorkflowID, &input.WorkflowID) != nil || decodeOptionalAuthoringValue(wire.VersionID, &input.VersionID) != nil {
		return experienceError(authoring.ErrExperienceBriefInvalid)
	}
	var strictBrief authoring.IntentBrief
	if decodeExperienceObject(wire.Brief, &strictBrief, []string{"version", "objective", "trigger", "inputs", "expectedOutcome", "externalEffects", "approvals", "failurePolicy", "examples", "language"}) != nil {
		return experienceError(authoring.ErrExperienceBriefInvalid)
	}
	input.Brief = strictBrief
	// Build before the registry transaction: catalog readers share the bounded
	// API pool and must not acquire a second connection while holding consent.
	input.Catalog = s.authoringCatalog(rc, r)
	entry, err := registry.Register(r.Context(), input)
	if err != nil {
		return experienceError(err)
	}
	// A duplicate explicit request returns the original active registration
	// (a different identity than the fresh ID); only a new row is audited.
	if entry.ID != input.ID {
		return opOK(entry)
	}
	s.audit.Write(r.Context(), s.pool, rc.authContext, "authoring.experience.registered", audit.Options{
		TargetType: "authoring_experience", TargetID: entry.ID, Metadata: map[string]any{"policyVersion": authoring.AuthoringExperiencePolicyVersion, "outcomeEvidence": "unknown"},
	})
	return opOK(entry)
}

func (s *V1Server) listAuthoringExperiencesCore(r *http.Request, rc v1Request) opResult {
	if denied := s.experiencePermissions(r, rc); denied != nil {
		return *denied
	}
	params, err := parseExperienceListQuery(r)
	if err != nil {
		return experienceError(err)
	}
	list, err := s.experienceRegistry().List(r.Context(), rc.orgID, params)
	if err != nil {
		return experienceError(err)
	}
	return opOK(list)
}

func parseExperienceListQuery(r *http.Request) (string, error) {
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || len(values) != 1 || len(values["workflowId"]) != 1 {
		return "", authoring.ErrExperienceBriefInvalid
	}
	return values.Get("workflowId"), nil
}

func (s *V1Server) revokeAuthoringExperienceCore(r *http.Request, rc v1Request) opResult {
	if denied := s.experiencePermissions(r, rc); denied != nil {
		return *denied
	}
	var wire authoringExperienceRevokeWire
	if decodeExperienceWire(r, &wire, []string{"id"}) != nil {
		return experienceError(authoring.ErrExperienceBriefInvalid)
	}
	var id string
	if decodeOptionalAuthoringValue(wire.ID, &id) != nil {
		return experienceError(authoring.ErrExperienceBriefInvalid)
	}
	revoked, changed, err := s.experienceRegistry().Revoke(r.Context(), rc.orgID, id)
	if err != nil {
		return experienceError(err)
	}
	if changed {
		s.audit.Write(r.Context(), s.pool, rc.authContext, "authoring.experience.revoked", audit.Options{TargetType: "authoring_experience", TargetID: id, Metadata: map[string]any{"policyVersion": authoring.AuthoringExperiencePolicyVersion}})
	}
	return opOK(map[string]any{"id": id, "revoked": revoked})
}

func (s *V1Server) mountAuthoringExperienceRoutes(mux *http.ServeMux) {
	readGate := routeGate{role: auth.RoleViewer, permission: "ai.write"}
	writeGate := routeGate{role: auth.RoleEditor, permission: "workflows.write"}
	s.route(mux, "GET /v1/authoring/experiences", readGate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.listAuthoringExperiencesCore(r, rc))
	})
	s.route(mux, "POST /v1/authoring/experiences/register", writeGate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.registerAuthoringExperienceCore(r, rc))
	})
	s.route(mux, "POST /v1/authoring/experiences/revoke", writeGate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.revokeAuthoringExperienceCore(r, rc))
	})
}
