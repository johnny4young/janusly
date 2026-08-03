// Credential CRUD + rotation + health (reference credentials-routes.ts).
// New secrets enter ONCE, get envelope-encrypted, and are never returned;
// legacy environment-variable references stay a deliberate compatibility
// mode. Neither managed references nor env-var names are echoed on the
// wire — the list projects a `storage: managed|environment` bit instead.
// Rotation previews its blast radius (dry run), then commits the version
// insert + reference swap + prior-version revocation + audit row in ONE
// transaction under a row lock with an optimistic ifMatch token.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/secretstore"
	"github.com/johnny4young/janusly/go/internal/store"
)

const (
	credentialNameMax   = 200
	credentialKindMax   = 100
	envVarNameMax       = 256
	secretValueMaxBytes = 64 * 1024
	usageLookbackDays   = 30
)

var envVarName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

type secretInput struct {
	managed bool
	value   string // managed: the secret value; legacy: the env-var NAME
}

// parseSecretInput enforces exactly-one-of (value, ref).
func parseSecretInput(body map[string]any, valueField, refField string) (secretInput, string) {
	rawValue, hasValue := body[valueField].(string)
	rawRef, hasRef := body[refField].(string)
	if hasValue == hasRef {
		return secretInput{}, "required"
	}
	if hasValue {
		if len(rawValue) == 0 || len(rawValue) > secretValueMaxBytes {
			return secretInput{}, "invalid"
		}
		return secretInput{managed: true, value: rawValue}, ""
	}
	if !envVarName.MatchString(rawRef) || len(rawRef) > envVarNameMax {
		return secretInput{}, "invalid"
	}
	// Shape alone never made a reference safe: the platform's own
	// configuration variables are shaped exactly like a tenant's.
	if !secretstore.EnvRefAllowed(rawRef) {
		return secretInput{}, "reserved"
	}
	return secretInput{managed: false, value: rawRef}, ""
}

// parseFutureExpiry: absent/null → no expiry; a string must be a valid
// FUTURE date (a past date is a config mistake, not a warning target).
func parseFutureExpiry(value any, present bool) (*time.Time, bool) {
	if !present || value == nil {
		return nil, true
	}
	raw, ok := value.(string)
	if !ok {
		return nil, false
	}
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil || !parsed.After(time.Now()) {
		return nil, false
	}
	return &parsed, true
}

// resolveCredentialReferences walks each active workflow's LATEST version
// once and returns the ids referencing the credential name (the rotation
// blast radius).
func (s *V1Server) resolveCredentialReferences(ctx context.Context, orgID, name string) []string {
	rows, err := store.New(s.pool).ListLatestWorkflowVersionDags(ctx, orgID)
	if err != nil {
		return []string{}
	}
	affected := make([]string, 0)
	for _, row := range rows {
		var dag struct {
			Nodes []struct {
				Config map[string]any `json:"config"`
			} `json:"nodes"`
		}
		if json.Unmarshal(row.DagJson, &dag) != nil {
			continue
		}
		for _, node := range dag.Nodes {
			if credentialNameFromConfig(node.Config) == name {
				affected = append(affected, row.WorkflowID)
				break
			}
		}
	}
	return affected
}

// credentialNameFromConfig mirrors the reference's two shapes:
// config.credential and config.input.credential.
func credentialNameFromConfig(config map[string]any) string {
	if direct, ok := config["credential"].(string); ok && direct != "" {
		return direct
	}
	if input, ok := config["input"].(map[string]any); ok {
		if nested, ok := input["credential"].(string); ok {
			return nested
		}
	}
	return ""
}

func (s *V1Server) listCredentialsHandler(w http.ResponseWriter, r *http.Request, rc v1Request) {
	rows, err := store.New(s.pool).ListCredentials(r.Context(), rc.orgID)
	if err != nil {
		writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	// Project WITHOUT secret_ref: only safe metadata + the storage bit.
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		storage := "environment"
		if secretstore.IsManagedCredentialSecretRef(row.SecretRef) {
			storage = "managed"
		}
		items = append(items, map[string]any{
			"id": row.ID, "orgId": row.OrgID, "name": row.Name, "kind": row.Kind,
			"metadata": rawOrNull(row.Metadata), "createdBy": textOrNull(row.CreatedBy),
			"createdAt": timeOrNull(row.CreatedAt), "expiresAt": timeOrNull(row.ExpiresAt),
			"storage": storage,
		})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(items)
}

func (s *V1Server) credentialHealthCore(r *http.Request, rc v1Request) opResult {
	ctx := r.Context()
	q := store.New(s.pool)
	rows, err := q.ListCredentials(ctx, rc.orgID)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	since := time.Now().UTC().AddDate(0, 0, -usageLookbackDays)
	usageRows, _ := q.ListCredentialUsageRows(ctx, store.ListCredentialUsageRowsParams{
		OrgID: rc.orgID, CreatedAt: &since,
	})
	type aggregate struct {
		lastUsedAt  *time.Time
		lastErrorAt *time.Time
		lastError   string
		usageCount  int
	}
	usage := map[string]*aggregate{}
	for _, row := range usageRows {
		name, _ := row.CredentialName.(string)
		if name == "" {
			continue
		}
		entry := usage[name]
		if entry == nil {
			entry = &aggregate{}
			usage[name] = entry
		}
		entry.usageCount++
		if entry.lastUsedAt == nil {
			entry.lastUsedAt = row.CreatedAt
		}
		okValue, _ := row.Ok.(bool)
		if !okValue && entry.lastErrorAt == nil {
			entry.lastErrorAt = row.CreatedAt
			if message, ok := row.ErrorMessage.(string); ok {
				entry.lastError = message
			}
		}
	}
	// One DAG walk feeds every credential's referencing-workflows list.
	dags, _ := q.ListLatestWorkflowVersionDags(ctx, rc.orgID)
	references := map[string][]string{}
	for _, dagRow := range dags {
		var dag struct {
			Nodes []struct {
				Config map[string]any `json:"config"`
			} `json:"nodes"`
		}
		if json.Unmarshal(dagRow.DagJson, &dag) != nil {
			continue
		}
		seen := map[string]bool{}
		for _, node := range dag.Nodes {
			name := credentialNameFromConfig(node.Config)
			if name != "" && !seen[name] {
				seen[name] = true
				references[name] = append(references[name], dagRow.WorkflowID)
			}
		}
	}
	entries := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		aggregateEntry := usage[row.Name]
		entry := map[string]any{
			"id": row.ID, "name": row.Name, "kind": row.Kind,
			"secretRefPresent": secretstore.HasCredentialSecretRef(ctx, q, rc.orgID, row.SecretRef),
			"lastUsedAt":       nil, "lastErrorAt": nil, "lastErrorMessage": nil,
			"usageCount30d":          0,
			"referencingWorkflowIds": append([]string{}, references[row.Name]...),
			"expiresAt":              timeOrNull(row.ExpiresAt),
		}
		if aggregateEntry != nil {
			entry["usageCount30d"] = aggregateEntry.usageCount
			entry["lastUsedAt"] = timeOrNull(aggregateEntry.lastUsedAt)
			entry["lastErrorAt"] = timeOrNull(aggregateEntry.lastErrorAt)
			if aggregateEntry.lastError != "" {
				entry["lastErrorMessage"] = aggregateEntry.lastError
			}
		}
		entries = append(entries, entry)
	}
	// MCP connections ride the same resolver so managed and legacy refs
	// can't drift: each env ref must resolve for the connection to be ok.
	mcpRows, _ := q.ListMcpConnectionsForHealth(ctx, rc.orgID)
	mcpEntries := make([]map[string]any, 0, len(mcpRows))
	for _, connection := range mcpRows {
		refsPresent := true
		var envRefs map[string]string
		_ = json.Unmarshal(connection.EnvRefs, &envRefs)
		for _, ref := range envRefs {
			if !secretstore.HasCredentialSecretRef(ctx, q, rc.orgID, ref) {
				refsPresent = false
				break
			}
		}
		mcpEntries = append(mcpEntries, map[string]any{
			"id": connection.ID, "alias": connection.Alias, "transport": connection.Transport,
			"enabled": connection.Enabled, "status": connection.Status,
			"secretRefsPresent": refsPresent,
		})
	}
	return opOK(map[string]any{"credentials": entries, "mcpConnections": mcpEntries})
}

func (s *V1Server) createCredentialCore(r *http.Request, rc v1Request) opResult {
	var body map[string]any
	if err := decodeBody(r, &body); err != nil {
		return opError(http.StatusBadRequest, "credentials_fields_required",
			"name, kind, and one secret source are required", nil)
	}
	name, _ := body["name"].(string)
	kind, _ := body["kind"].(string)
	name, kind = strings.TrimSpace(name), strings.TrimSpace(kind)
	if name == "" || len(name) > credentialNameMax || kind == "" || len(kind) > credentialKindMax {
		return opError(http.StatusBadRequest, "credentials_fields_required",
			"name, kind, and one secret source are required", nil)
	}
	secret, problem := parseSecretInput(body, "secretValue", "secretRef")
	if problem != "" {
		code, message := "credentials_invalid_secret_ref", "Provide exactly one of secretValue or secretRef"
		switch problem {
		case "required":
			code = "credentials_fields_required"
		case "reserved":
			code = "credentials_reserved_secret_ref"
			message = "secretRef names a reserved platform variable; use the managed store or a JANUSLY_CRED_ name"
		}
		return opError(http.StatusBadRequest, code, message, nil)
	}
	_, expiryPresent := body["expiresAt"]
	expiresAt, ok := parseFutureExpiry(body["expiresAt"], expiryPresent)
	if !ok {
		return opError(http.StatusBadRequest, "credentials_invalid_expiry",
			"expiresAt must be a valid future ISO date or null", nil)
	}
	id := s.newID()
	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return opError(http.StatusInternalServerError, "credentials_create_failed", "Creating credential failed", nil)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	txq := store.New(tx)

	secretRef := secret.value
	if secret.managed {
		_, _, managedRef, err := secretstore.CreateCredentialSecretVersion(ctx, txq, struct {
			ID           string
			OrgID        string
			CredentialID string
			SecretValue  string
			CreatedBy    string
		}{OrgID: rc.orgID, CredentialID: id, SecretValue: secret.value, CreatedBy: rc.userID})
		if err != nil {
			if errors.Is(err, secretstore.ErrRootKeyMissing) || errors.Is(err, secretstore.ErrRootKeyInvalid) {
				return opError(http.StatusInternalServerError, "credentials_secret_store_unavailable",
					"Managed secret storage is not configured", nil)
			}
			return opError(http.StatusInternalServerError, "credentials_create_failed", "Creating credential failed", nil)
		}
		secretRef = managedRef
	}
	metadataJSON, _ := json.Marshal(map[string]any{})
	if raw, ok := body["metadata"].(map[string]any); ok {
		metadataJSON, _ = json.Marshal(raw)
	}
	if err := txq.InsertCredentialFull(ctx, store.InsertCredentialFullParams{
		ID: id, OrgID: rc.orgID, Name: name, Kind: kind, SecretRef: secretRef,
		Metadata:  metadataJSON,
		ExpiresAt: expiresAt,
		CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
	}); err != nil {
		if strings.Contains(err.Error(), "credentials_org_name_idx") {
			return opError(http.StatusConflict, "credentials_conflict", "Credential name already exists", nil)
		}
		return opError(http.StatusInternalServerError, "credentials_create_failed", "Creating credential failed", nil)
	}
	auditMetadata, _ := json.Marshal(map[string]any{
		"kind": kind, "storage": map[bool]string{true: "managed", false: "legacy"}[secret.managed],
		"hasExpiry": expiresAt != nil,
	})
	if err := txq.InsertAuditLogRow(ctx, store.InsertAuditLogRowParams{
		ID: s.newID(), OrgID: rc.orgID,
		UserID:     pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		Action:     "credential.created",
		TargetType: pgtype.Text{String: "credential", Valid: true},
		TargetID:   pgtype.Text{String: id, Valid: true},
		Metadata:   auditMetadata,
	}); err != nil {
		return opError(http.StatusInternalServerError, "credentials_create_failed", "Creating credential failed", nil)
	}
	if err := tx.Commit(ctx); err != nil {
		return opError(http.StatusInternalServerError, "credentials_create_failed", "Creating credential failed", nil)
	}
	return opOK(map[string]any{"id": id})
}

func (s *V1Server) bulkUpdateCredentialCore(r *http.Request, rc v1Request, name string) opResult {
	var body map[string]any
	_ = decodeBody(r, &body)
	ctx := r.Context()
	q := store.New(s.pool)
	credential, err := q.GetCredentialByOrgName(ctx, store.GetCredentialByOrgNameParams{OrgID: rc.orgID, Name: name})
	if err != nil {
		return opError(http.StatusNotFound, "credentials_not_found", "credential not found", nil)
	}
	if body["dryRun"] == true {
		affected := s.resolveCredentialReferences(ctx, rc.orgID, name)
		return opOK(map[string]any{
			"credentialName": name, "kind": credential.Kind, "updatedAt": credential.UpdatedAt,
			"affected": affected, "affectedCount": len(affected),
		})
	}
	secret, problem := parseSecretInput(body, "newSecretValue", "newSecretRef")
	if problem != "" {
		// Rotation is the other way a credential can acquire a reserved
		// reference, so it needs the same distinct answer as creation.
		if problem == "reserved" {
			return opError(http.StatusBadRequest, "credentials_reserved_secret_ref",
				"newSecretRef names a reserved platform variable; use the managed store or a JANUSLY_CRED_ name", nil)
		}
		return opError(http.StatusBadRequest, "credentials_invalid_secret_ref",
			"Provide exactly one of newSecretValue or newSecretRef", nil)
	}
	ifMatchRaw, _ := body["ifMatch"].(string)
	if ifMatchRaw == "" {
		return opError(http.StatusBadRequest, "credentials_if_match_required",
			"ifMatch is required — send the updatedAt token from the dry-run preview response", nil)
	}
	ifMatch, err := time.Parse(time.RFC3339, ifMatchRaw)
	if err != nil {
		return opError(http.StatusBadRequest, "credentials_if_match_invalid",
			"ifMatch must be a valid ISO updatedAt token from the dry-run preview", nil)
	}
	affected := s.resolveCredentialReferences(ctx, rc.orgID, name)

	// Atomic: row lock → CAS on the preview token → version insert →
	// reference swap → prior revocation → audit. One commit or nothing.
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return opError(http.StatusInternalServerError, "credentials_rotation_failed", "Credential rotation failed", nil)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	txq := store.New(tx)
	locked, err := txq.LockCredentialByName(ctx, store.LockCredentialByNameParams{OrgID: rc.orgID, Name: name})
	if err != nil {
		return opError(http.StatusNotFound, "credentials_not_found", "credential not found", nil)
	}
	if !locked.UpdatedAt.Equal(ifMatch) {
		return opError(http.StatusConflict, "credential_rotation_conflict",
			"Credential changed since preview; re-preview before rotating", nil)
	}
	newSecretRef := secret.value
	if secret.managed {
		_, _, managedRef, err := secretstore.CreateCredentialSecretVersion(ctx, txq, struct {
			ID           string
			OrgID        string
			CredentialID string
			SecretValue  string
			CreatedBy    string
		}{OrgID: rc.orgID, CredentialID: locked.ID, SecretValue: secret.value, CreatedBy: rc.userID})
		if err != nil {
			if errors.Is(err, secretstore.ErrRootKeyMissing) || errors.Is(err, secretstore.ErrRootKeyInvalid) {
				return opError(http.StatusInternalServerError, "credentials_secret_store_unavailable",
					"Managed secret storage is not configured", nil)
			}
			return opError(http.StatusInternalServerError, "credentials_rotation_failed", "Credential rotation failed", nil)
		}
		newSecretRef = managedRef
	}
	rotatedAt, err := txq.RotateCredentialSecretRefCAS(ctx, store.RotateCredentialSecretRefCASParams{
		OrgID: rc.orgID, Name: name, NewSecretRef: newSecretRef, IfMatch: locked.UpdatedAt,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusConflict, "credential_rotation_conflict",
				"Credential changed since preview; re-preview before rotating", nil)
		}
		return opError(http.StatusInternalServerError, "credentials_rotation_failed", "Credential rotation failed", nil)
	}
	if err := secretstore.RevokeCredentialSecretRef(ctx, txq, rc.orgID, locked.SecretRef); err != nil {
		return opError(http.StatusInternalServerError, "credentials_rotation_failed", "Credential rotation failed", nil)
	}
	auditMetadata, _ := json.Marshal(map[string]any{
		"kind": locked.Kind, "storage": map[bool]string{true: "managed", false: "legacy"}[secret.managed],
		"affectedWorkflowIds": affected, "affectedWorkflowCount": len(affected),
	})
	if err := txq.InsertAuditLogRow(ctx, store.InsertAuditLogRowParams{
		ID: s.newID(), OrgID: rc.orgID,
		UserID:     pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		Action:     "credential.bulk_updated",
		TargetType: pgtype.Text{String: "credential", Valid: true},
		TargetID:   pgtype.Text{String: name, Valid: true},
		Metadata:   auditMetadata,
	}); err != nil {
		return opError(http.StatusInternalServerError, "credentials_rotation_failed", "Credential rotation failed", nil)
	}
	if err := tx.Commit(ctx); err != nil {
		return opError(http.StatusInternalServerError, "credentials_rotation_failed", "Credential rotation failed", nil)
	}
	return opOK(map[string]any{
		"ok": true, "credentialName": name,
		"affected": affected, "affectedCount": len(affected), "updatedAt": rotatedAt,
	})
}

func (s *V1Server) deleteCredentialCore(r *http.Request, rc v1Request, name string) opResult {
	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return opError(http.StatusInternalServerError, "credentials_revoke_failed", "Revoking credential failed", nil)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	txq := store.New(tx)
	credential, err := txq.GetCredentialByOrgName(ctx, store.GetCredentialByOrgNameParams{OrgID: rc.orgID, Name: name})
	if err != nil {
		return opError(http.StatusNotFound, "credentials_not_found", "credential not found", nil)
	}
	deleted, err := txq.DeleteCredential(ctx, store.DeleteCredentialParams{OrgID: rc.orgID, ID: credential.ID})
	if err != nil || deleted == 0 {
		return opError(http.StatusNotFound, "credentials_not_found", "credential not found", nil)
	}
	if err := secretstore.RevokeCredentialSecretRef(ctx, txq, rc.orgID, credential.SecretRef); err != nil {
		return opError(http.StatusInternalServerError, "credentials_revoke_failed", "Revoking credential failed", nil)
	}
	auditMetadata, _ := json.Marshal(map[string]any{"kind": credential.Kind})
	if err := txq.InsertAuditLogRow(ctx, store.InsertAuditLogRowParams{
		ID: s.newID(), OrgID: rc.orgID,
		UserID:     pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		Action:     "credential.revoked",
		TargetType: pgtype.Text{String: "credential", Valid: true},
		TargetID:   pgtype.Text{String: credential.ID, Valid: true},
		Metadata:   auditMetadata,
	}); err != nil {
		return opError(http.StatusInternalServerError, "credentials_revoke_failed", "Revoking credential failed", nil)
	}
	if err := tx.Commit(ctx); err != nil {
		return opError(http.StatusInternalServerError, "credentials_revoke_failed", "Revoking credential failed", nil)
	}
	return opOK(map[string]any{"ok": true})
}

func (s *V1Server) credentialExpiryCore(r *http.Request, rc v1Request, name string) opResult {
	var body map[string]any
	_ = decodeBody(r, &body)
	// Clearing must be EXPLICIT on the dedicated endpoint: `expiresAt`
	// present (future date or null); an omitted field cannot silently
	// wipe a live expiry.
	rawExpiry, present := body["expiresAt"]
	if !present {
		return opError(http.StatusBadRequest, "credentials_expiry_required",
			"expiresAt is required — a future ISO date to set, or null to clear", nil)
	}
	expiresAt, ok := parseFutureExpiry(rawExpiry, true)
	if !ok {
		return opError(http.StatusBadRequest, "credentials_invalid_expiry",
			"expiresAt must be a valid future ISO date or null to clear", nil)
	}
	var ifMatch *time.Time
	if raw, ok := body["ifMatch"].(string); ok && raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return opError(http.StatusBadRequest, "credentials_if_match_invalid",
				"ifMatch must be a valid ISO updatedAt token", nil)
		}
		ifMatch = &parsed
	}
	ctx := r.Context()
	q := store.New(s.pool)
	if _, err := q.GetCredentialByOrgName(ctx, store.GetCredentialByOrgNameParams{OrgID: rc.orgID, Name: name}); err != nil {
		return opError(http.StatusNotFound, "credentials_not_found", "credential not found", nil)
	}
	updatedAt, err := q.SetCredentialExpiry(ctx, store.SetCredentialExpiryParams{
		OrgID: rc.orgID, Name: name, ExpiresAt: expiresAt, IfMatch: ifMatch,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusConflict, "credential_expiry_conflict",
				"Credential changed since load; reload before setting expiry", nil)
		}
		return opError(http.StatusInternalServerError, "credentials_expiry_failed", "Setting credential expiry failed", nil)
	}
	audit := map[string]any{"hasExpiry": expiresAt != nil}
	if expiresAt != nil {
		audit["expiresAt"] = expiresAt.UTC().Format(time.RFC3339Nano)
	}
	auditMetadata, _ := json.Marshal(audit)
	_ = q.InsertAuditLogRow(ctx, store.InsertAuditLogRowParams{
		ID: s.newID(), OrgID: rc.orgID,
		UserID:     pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		Action:     "credential.expiry_set",
		TargetType: pgtype.Text{String: "credential", Valid: true},
		TargetID:   pgtype.Text{String: name, Valid: true},
		Metadata:   auditMetadata,
	})
	response := map[string]any{"ok": true, "credentialName": name, "updatedAt": updatedAt, "expiresAt": nil}
	if expiresAt != nil {
		response["expiresAt"] = expiresAt.UTC().Format(time.RFC3339Nano)
	}
	return opOK(response)
}

func (s *V1Server) mountCredentialRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /credentials", s.auth(s.listCredentialsHandler))
	mux.HandleFunc("GET /credentials/health", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.credentialHealthCore(r, rc))
	}))
	mux.HandleFunc("POST /credentials", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.createCredentialCore(r, rc))
	}))
	mux.HandleFunc("POST /credentials/{name}/bulk-update", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.bulkUpdateCredentialCore(r, rc, r.PathValue("name")))
	}))
	mux.HandleFunc("DELETE /credentials/{name}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.deleteCredentialCore(r, rc, r.PathValue("name")))
	}))
	mux.HandleFunc("POST /credentials/{name}/expiry", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.credentialExpiryCore(r, rc, r.PathValue("name")))
	}))
}
