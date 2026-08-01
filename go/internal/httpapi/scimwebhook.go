// The public WorkOS webhook receiver (T-502 split): signature gate →
// JSON/envelope validation → org binding by provider_directory_id →
// dispatcher; always 200 on guard rejections, 5xx only on real I/O.
package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/go/internal/store"
)

/* ------------------------------ webhook route ----------------------------- */

func (s *V1Server) scimWebhookHandler(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rawBody, _ := io.ReadAll(io.LimitReader(r.Body, scimBodyMaxBytes))
	header := r.Header.Get("WorkOS-Signature")

	if valid, reason := verifyWorkOsSignature(header, string(rawBody), os.Getenv("WORKOS_WEBHOOK_SECRET"), time.Now()); !valid {
		// No org context yet — audit against the "default" tenant for
		// forensics, the reference's posture.
		s.scimAudit(ctx, "default", "scim.webhook.signature_invalid", "scim_event", "", map[string]any{
			"reason": reason,
		})
		writeLegacy(w, opError(http.StatusUnauthorized, "scim_invalid_signature", "invalid signature", nil))
		return
	}

	var parsed map[string]any
	if err := json.Unmarshal(rawBody, &parsed); err != nil {
		writeLegacy(w, opError(http.StatusBadRequest, "scim_invalid_json", "invalid JSON", nil))
		return
	}
	event := asScimEvent(parsed)
	if event == nil {
		writeLegacy(w, opError(http.StatusBadRequest, "scim_invalid_event_payload", "invalid event payload", nil))
		return
	}

	directoryID := extractScimDirectoryID(event)
	if directoryID == "" {
		s.scimAudit(ctx, "default", "scim.webhook.missing_directory_id", "scim_event", event.ID, map[string]any{
			"eventType": event.Event,
		})
		writeLegacy(w, opOK(map[string]any{"ok": true, "processed": false, "reason": "missing_directory_id"}))
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
			writeLegacy(w, opOK(map[string]any{"ok": true, "processed": false, "reason": "unknown_directory"}))
			return
		}
		writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	if directory.Status == "revoked" {
		s.scimAudit(ctx, directory.OrgID, "scim.webhook.directory_revoked", "scim_event", event.ID, map[string]any{
			"eventType": event.Event, "scimDirectoryId": directory.ID,
		})
		writeLegacy(w, opOK(map[string]any{"ok": true, "processed": false, "reason": "directory_revoked"}))
		return
	}

	result, err := s.handleScimEvent(ctx, directory, event)
	if err != nil {
		writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	response := map[string]any{"ok": true, "processed": result.Processed}
	if result.Action != "" {
		response["action"] = result.Action
	}
	if result.Reason != "" {
		response["reason"] = result.Reason
	}
	writeLegacy(w, opOK(response))
}
