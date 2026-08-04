// The public WorkOS webhook receiver: signature gate →
// JSON/envelope validation → org binding by provider_directory_id →
// dispatcher; always 200 on guard rejections, 5xx only on real I/O.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/internal/store"
	"log/slog"
)

/* ------------------------------ webhook route ----------------------------- */

func (s *V1Server) scimWebhookHandler(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rawBody, ok := readRawBody(w, r, scimBodyMaxBytes)
	if !ok {
		return
	}
	header := r.Header.Get("WorkOS-Signature")

	if valid, reason := verifyWorkOsSignature(header, string(rawBody), os.Getenv("WORKOS_WEBHOOK_SECRET"), time.Now()); !valid {
		// No org context yet — audit against the "default" tenant for
		// forensics, the contract's posture.
		s.scimAudit(ctx, "default", "scim.webhook.signature_invalid", "scim_event", "", map[string]any{
			"reason": reason,
		})
		writeUnversioned(w, opError(http.StatusUnauthorized, "scim_invalid_signature", "invalid signature", nil))
		return
	}

	var parsed map[string]any
	if err := json.Unmarshal(rawBody, &parsed); err != nil {
		writeUnversioned(w, opError(http.StatusBadRequest, "scim_invalid_json", "invalid JSON", nil))
		return
	}
	event := asScimEvent(parsed)
	if event == nil {
		writeUnversioned(w, opError(http.StatusBadRequest, "scim_invalid_event_payload", "invalid event payload", nil))
		return
	}

	directoryID := extractScimDirectoryID(event)
	if directoryID == "" {
		s.scimAudit(ctx, "default", "scim.webhook.missing_directory_id", "scim_event", event.ID, map[string]any{
			"eventType": event.Event,
		})
		writeUnversioned(w, opOK(map[string]any{"ok": true, "processed": false, "reason": "missing_directory_id"}))
		return
	}

	directory, err := store.New(s.pool).GetScimDirectoryByProviderDirectoryID(ctx, directoryID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Unknown directory — 200 so WorkOS stops retrying (it may
			// have been disconnected here with retries still pending).
			s.scimAudit(ctx, "default", "scim.webhook.unknown_directory", "scim_event", event.ID, map[string]any{
				"eventType": event.Event, "directoryId": directoryID,
			})
			writeUnversioned(w, opOK(map[string]any{"ok": true, "processed": false, "reason": "unknown_directory"}))
			return
		}
		writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	if directory.Status == "revoked" {
		s.scimAudit(ctx, directory.OrgID, "scim.webhook.directory_revoked", "scim_event", event.ID, map[string]any{
			"eventType": event.Event, "scimDirectoryId": directory.ID,
		})
		writeUnversioned(w, opOK(map[string]any{"ok": true, "processed": false, "reason": "directory_revoked"}))
		return
	}

	result, err := s.handleScimEvent(ctx, directory, event)
	if err != nil {
		// The generic 500 is deliberate (no internals to the caller), but
		// the CAUSE must land in the logs or a prod 500 is undiagnosable.
		slog.Warn("scim webhook event failed", "eventId", event.ID,
			"eventType", event.Event, "error", err)
		writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	response := map[string]any{"ok": true, "processed": result.Processed}
	if result.Action != "" {
		response["action"] = result.Action
	}
	if result.Reason != "" {
		response["reason"] = result.Reason
	}
	writeUnversioned(w, opOK(response))
}
