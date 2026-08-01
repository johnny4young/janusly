// Org-wide event-driven trigger ingestion (reference
// apps/api/src/routes/trigger-ingest-routes.ts): the normalized inbound
// seam for `email_received` — and the shared org-wide selector resolver
// the other event triggers reuse. The relay/bucket-listener/subscriber
// has already normalized the upstream event; these routes validate the
// transport-agnostic payload, resolve the UNIQUE matching trigger node
// across the org's active workflows, and feed the shared durable
// pipeline (webhooks.go ingestTriggerEventCore).
//
// Email specifics: the DKIM gate is opt-OUT (`dkimRequired` defaults to
// true), the optional `fromDomains` allow-list rejects unlisted senders,
// the text body is byte-capped at 1 MiB (authoritative gate — the schema
// char cap is only a guard), and attachment BODIES never enter
// trigger_events: they ride the out-of-band base64 `attachmentBodies`
// field, are per-attachment capped at 1 MiB, and are offloaded to the
// object store under the per-org prefix BEFORE the event persists, so the
// persisted payload carries object keys. A messageId dedupe pre-check
// runs BEFORE any upload so a relay retry cannot orphan objects.
package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/objectstore"
	"github.com/johnny4young/janusly/go/internal/store"
)

const (
	emailIngestMaxJSONBytes = 4 * 1_048_576
	emailBodyMaxBytes       = 1_048_576
	emailAttachmentMax      = 20
	emailAttachmentMaxBytes = 1_048_576
)

var (
	emailAliasPattern    = regexp.MustCompile(`^[a-zA-Z0-9._+-]+$`)
	attachmentNameUnsafe = regexp.MustCompile(`[^a-zA-Z0-9._-]`)
)

// resolvedTriggerNode is one org-wide selector match.
type resolvedTriggerNode struct {
	workflowID string
	nodeID     string
	nodeConfig map[string]any
}

// resolveUniqueTriggerNode scans the latest version of every active
// workflow in the org for trigger nodes of `triggerType` whose config
// matches. Exactly one match resolves; zero and many are the caller's
// 404/409. Mirrors the reference's resolveUniqueTriggerNode.
func resolveUniqueTriggerNode(
	ctx context.Context, q *store.Queries, orgID, triggerType string,
	match func(config map[string]any) bool,
) (*resolvedTriggerNode, bool, error) {
	rows, err := q.ListLatestWorkflowVersionDags(ctx, orgID)
	if err != nil {
		return nil, false, err
	}
	var matches []resolvedTriggerNode
	for _, row := range rows {
		wf, _ := domain.Parse(row.DagJson)
		if wf == nil {
			continue
		}
		for _, node := range wf.Nodes {
			if node.Type != triggerType || !match(node.Config) {
				continue
			}
			matches = append(matches, resolvedTriggerNode{
				workflowID: row.WorkflowID, nodeID: node.ID, nodeConfig: node.Config,
			})
		}
	}
	switch len(matches) {
	case 0:
		return nil, false, nil
	case 1:
		return &matches[0], false, nil
	default:
		return nil, true, nil
	}
}

type emailAttachmentMeta struct {
	Filename    string  `json:"filename"`
	ContentType string  `json:"contentType,omitempty"`
	SizeBytes   float64 `json:"sizeBytes,omitempty"`
}

type emailIngestBody struct {
	AliasKey    string                `json:"aliasKey"`
	From        string                `json:"from"`
	To          string                `json:"to"`
	Subject     string                `json:"subject"`
	Body        string                `json:"body"`
	DkimPass    bool                  `json:"dkimPass"`
	MessageID   string                `json:"messageId"`
	Attachments []emailAttachmentMeta `json:"attachments"`
	ReceivedAt  string                `json:"receivedAt"`
	// Out-of-band base64 bodies keyed by filename (or index) — never
	// persisted; offloaded to the object store.
	AttachmentBodies map[string]string `json:"attachmentBodies"`
}

func (s *V1Server) ingestEmail(w http.ResponseWriter, r *http.Request, rc v1Request) {
	writeVersioned(w, rc.id, s.emailIngestCore(r, rc))
}

func (s *V1Server) emailIngestCore(r *http.Request, rc v1Request) opResult {
	ctx := r.Context()
	q := store.New(s.pool)

	var body emailIngestBody
	if err := json.NewDecoder(http.MaxBytesReader(nil, r.Body, emailIngestMaxJSONBytes)).Decode(&body); err != nil {
		return opError(http.StatusBadRequest, "trigger_invalid_payload", "Invalid email payload", nil)
	}
	aliasKey := strings.TrimSpace(body.AliasKey)
	from := strings.TrimSpace(body.From)
	messageID := strings.TrimSpace(body.MessageID)
	switch {
	case aliasKey == "" || len(aliasKey) > 128 || !emailAliasPattern.MatchString(aliasKey):
		return opError(http.StatusBadRequest, "trigger_invalid_payload", "aliasKey must be a valid email local-part", nil)
	case from == "" || len(from) > 512:
		return opError(http.StatusBadRequest, "trigger_invalid_payload", "from must be 1..512 characters", nil)
	case len(body.To) > 512 || len(body.Subject) > 2048 || len(messageID) > 998 || len(body.ReceivedAt) > 64:
		return opError(http.StatusBadRequest, "trigger_invalid_payload", "email envelope field exceeds its cap", nil)
	case len(body.Attachments) > emailAttachmentMax:
		return opError(http.StatusBadRequest, "trigger_invalid_payload",
			fmt.Sprintf("at most %d attachments", emailAttachmentMax), nil)
	}
	for _, meta := range body.Attachments {
		if strings.TrimSpace(meta.Filename) == "" || len(meta.Filename) > 512 || len(meta.ContentType) > 256 {
			return opError(http.StatusBadRequest, "trigger_invalid_payload", "invalid attachment metadata", nil)
		}
	}
	// Authoritative byte-length gate on the text body (1 MiB).
	if len(body.Body) > emailBodyMaxBytes {
		return opError(http.StatusRequestEntityTooLarge, "trigger_payload_too_large", "Email body exceeds 1 MiB cap", nil)
	}

	resolved, ambiguous, err := resolveUniqueTriggerNode(ctx, q, rc.orgID, "email_received", func(config map[string]any) bool {
		configured, _ := config["aliasKey"].(string)
		return strings.EqualFold(strings.TrimSpace(configured), aliasKey)
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
	}
	if ambiguous {
		return opError(http.StatusConflict, "trigger_selector_ambiguous", "Multiple active workflows use this email alias", nil)
	}
	if resolved == nil {
		return opError(http.StatusNotFound, "trigger_no_matching_node", "No email_received trigger matches this alias", nil)
	}

	// DKIM gate — the node opts INTO requiring DKIM (default true). An
	// unverified sender is rejected unless the operator opted out.
	if dkimRequired, ok := resolved.nodeConfig["dkimRequired"].(bool); (!ok || dkimRequired) && !body.DkimPass {
		return opError(http.StatusForbidden, "trigger_dkim_required", "Inbound email failed the DKIM check", nil)
	}
	// Optional sender-domain allow-list.
	if rawDomains, ok := resolved.nodeConfig["fromDomains"].([]any); ok && len(rawDomains) > 0 {
		senderDomain := ""
		if at := strings.LastIndex(from, "@"); at >= 0 {
			senderDomain = strings.ToLower(from[at+1:])
		}
		allowed := false
		for _, rawDomain := range rawDomains {
			if listed, ok := rawDomain.(string); ok && strings.EqualFold(listed, senderDomain) {
				allowed = true
				break
			}
		}
		if !allowed {
			return opError(http.StatusForbidden, "trigger_dkim_required", "Sender domain is not in the allow-list", nil)
		}
	}

	// Idempotency pre-check BEFORE any object-store upload: a relay retry
	// (same messageId) must not re-upload and orphan objects. A NULL
	// messageId never dedupes — nothing to converge on.
	dedupeKey, eventID := "", ""
	if messageID != "" {
		dedupeKey = "email:" + messageID
		// Deterministic event id so retried deliveries key the SAME
		// attachment prefix as the persisted row.
		eventID = "email-" + shortHash(rc.orgID+"\x00"+dedupeKey, 40)
		if prior, err := q.FindTriggerEventByDedupe(ctx, store.FindTriggerEventByDedupeParams{
			OrgID: rc.orgID, DedupeKey: pgtype.Text{String: dedupeKey, Valid: true},
		}); err == nil && prior.Status != "received" {
			return opOK(map[string]any{
				"ok": true, "duplicate": true,
				"triggerEventId": prior.ID, "runId": textOrNull(prior.RunID),
			})
		}
	}

	receivedAt := strings.TrimSpace(body.ReceivedAt)
	if receivedAt == "" {
		receivedAt = time.Now().UTC().Format(time.RFC3339)
	}
	storedAttachments := offloadEmailAttachments(rc.orgID, eventID, body.Attachments, body.AttachmentBodies)
	eventPayload := map[string]any{
		"aliasKey": aliasKey, "from": from, "to": body.To,
		"subject": body.Subject, "body": body.Body, "dkimPass": body.DkimPass,
		"messageId": messageID, "attachments": storedAttachments, "receivedAt": receivedAt,
	}
	return s.ingestTriggerEventCore(ctx, triggerIngestRequest{
		orgID:        rc.orgID,
		authContext:  rc.authContext,
		createdBy:    rc.userID,
		workflowID:   resolved.workflowID,
		triggerType:  "email_received",
		eventPayload: eventPayload,
		dedupeKey:    dedupeKey,
		eventID:      eventID,
		noMatch: opError(http.StatusNotFound, "trigger_no_matching_node",
			"No email_received trigger matches this alias", nil),
		matchNode: func(candidate *domain.Workflow, noMatch opResult) (string, opResult) {
			for _, node := range candidate.Nodes {
				if node.ID == resolved.nodeID && node.Type == "email_received" {
					return node.ID, opResult{}
				}
			}
			return "", noMatch
		},
	})
}

// offloadEmailAttachments uploads capped attachment bodies under the
// per-org prefix and returns the metadata with object keys. Upload
// failures degrade to {stored:false} — the run still starts; the operator
// sees the attachment was dropped. eventID "" (no messageId) still gets a
// stable per-delivery prefix from the caller-less fallback below.
func offloadEmailAttachments(
	orgID, eventID string,
	attachments []emailAttachmentMeta, bodies map[string]string,
) []any {
	out := make([]any, 0, len(attachments))
	for index, meta := range attachments {
		entry := map[string]any{
			"filename": meta.Filename, "sizeBytes": meta.SizeBytes, "stored": false,
		}
		if meta.ContentType != "" {
			entry["contentType"] = meta.ContentType
		}
		rawBase64 := ""
		if bodies != nil {
			rawBase64 = bodies[meta.Filename]
			if rawBase64 == "" {
				rawBase64 = bodies[fmt.Sprint(index)]
			}
		}
		if rawBase64 == "" {
			out = append(out, entry)
			continue
		}
		decoded, err := base64.StdEncoding.DecodeString(rawBase64)
		if err != nil {
			entry["sizeBytes"] = 0
			out = append(out, entry)
			continue
		}
		entry["sizeBytes"] = len(decoded)
		// Per-attachment 1 MiB cap — oversized attachments are dropped.
		if len(decoded) > emailAttachmentMaxBytes {
			out = append(out, entry)
			continue
		}
		// Sanitize the filename into the object key — the per-org prefix is
		// the tenant-isolation boundary; a ../ in the filename must not
		// escape it.
		safeName := attachmentNameUnsafe.ReplaceAllString(meta.Filename, "_")
		// The object store refuses any key containing "..": drop the
		// sequences entirely rather than fail the upload.
		for strings.Contains(safeName, "..") {
			safeName = strings.ReplaceAll(safeName, "..", "")
		}
		if len(safeName) > 200 {
			safeName = safeName[:200]
		}
		if strings.Trim(safeName, "_.") == "" {
			safeName = "attachment"
		}
		prefix := eventID
		if prefix == "" {
			prefix = "adhoc-" + shortHash(orgID+meta.Filename+fmt.Sprint(index, len(decoded)), 16)
		}
		objectKey := fmt.Sprintf("orgs/%s/email/%s/%d-%s", orgID, prefix, index, safeName)
		result := objectstore.Put("", objectKey, decoded, meta.ContentType)
		if result.Ok {
			entry["stored"] = true
			entry["objectKey"] = objectKey
		}
		out = append(out, entry)
	}
	return out
}

// shortHash is the truncated-hex SHA-256 used for deterministic ids.
func shortHash(value string, length int) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])[:length]
}
