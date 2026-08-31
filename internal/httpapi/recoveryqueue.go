// Recovery queue read-model — GET /dlq/queue: the keyset ("load more")
// page over dead_letters LEFT JOINed to its recovery_items overlay,
// filtered + sorted SERVER-SIDE before the cap so a matching row older
// than the newest page still surfaces. The bare GET /dlq array reuses
// the same join for the home preview. The dynamic WHERE is built here as
// raw SQL from closed-set fragments with every user value
// parameter-bound (sqlc cannot type the per-sort keyset; the drill CTE
// set the raw-read precedent).
package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/johnny4young/janusly/internal/domain"
)

// recoveryQueuePageDefault / Max bound one keyset page; the +1 over-fetch
// stays under the bare-list max so hasMore is honest.
const (
	recoveryQueuePageDefault = 50
	recoveryQueuePageMax     = 100
	dlqListDefaultLimit      = 100
	dlqListMaxLimit          = 200
)

// recoveryQueueSorts is the closed sort set (mirrors the web SORT_KEYS).
var recoveryQueueSorts = map[string]bool{"newest": true, "oldest": true, "severity": true, "sla": true}

// recoveryQueueCursor is a decoded keyset position: (createdAt, id) is
// the stable tie-break shared by every sort; key is the lead-sort value
// (severity text / sla ISO instant) or nil for newest/oldest and for the
// NULLS LAST tail.
type recoveryQueueCursor struct {
	createdAt time.Time
	id        string
	key       *string
}

type recoveryQueueCursorWire struct {
	S string  `json:"s"`
	C string  `json:"c"`
	I string  `json:"i"`
	K *string `json:"k"`
}

// encodeRecoveryQueueCursor mints the opaque URL-safe cursor from the
// last row of a page. Unsigned on purpose: it only names a sort position
// and every query re-applies the org scope independently, so a tampered
// cursor can only reorder the caller's own page.
func encodeRecoveryQueueCursor(sort string, row recoveryQueueRow) string {
	var key *string
	switch sort {
	case "severity":
		key = row.severityKey
	case "sla":
		if row.slaKey != nil {
			iso := row.slaKey.UTC().Format(time.RFC3339Nano)
			key = &iso
		}
	}
	payload, _ := json.Marshal(recoveryQueueCursorWire{
		S: sort, C: row.createdAt.UTC().Format(time.RFC3339Nano), I: row.id, K: key,
	})
	return base64.RawURLEncoding.EncodeToString(payload)
}

// decodeRecoveryQueueCursor is defensive: malformed, wrong-shape, or
// minted under a DIFFERENT sort than the caller now requests → nil, and
// the route serves page 1 rather than mis-ordering it.
func decodeRecoveryQueueCursor(raw, expectedSort string) *recoveryQueueCursor {
	if raw == "" {
		return nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		if decoded, err = base64.URLEncoding.DecodeString(raw); err != nil {
			return nil
		}
	}
	var wire recoveryQueueCursorWire
	if json.Unmarshal(decoded, &wire) != nil || wire.S != expectedSort || wire.I == "" {
		return nil
	}
	createdAt, err := time.Parse(time.RFC3339Nano, wire.C)
	if err != nil {
		return nil
	}
	if expectedSort == "sla" && wire.K != nil {
		if _, err := time.Parse(time.RFC3339Nano, *wire.K); err != nil {
			return nil
		}
	}
	return &recoveryQueueCursor{createdAt: createdAt, id: wire.I, key: wire.K}
}

var dayPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// parseDayRange parses a YYYY-MM-DD UTC day into [start, end) bounds;
// malformed values are dropped (nil) — the heatmap drill-in contract.
func parseDayRange(day string) (start, end time.Time, ok bool) {
	if !dayPattern.MatchString(day) {
		return time.Time{}, time.Time{}, false
	}
	start, err := time.Parse("2006-01-02", day)
	if err != nil {
		return time.Time{}, time.Time{}, false
	}
	return start.UTC(), start.UTC().Add(24 * time.Hour), true
}

// recoveryQueueRow carries the wire view plus the raw keyset fields the
// cursor mints from (the view already stringified them).
type recoveryQueueRow struct {
	view        map[string]any
	id          string
	createdAt   time.Time
	severityKey *string
	slaKey      *time.Time
}

type recoveryQueueQuery struct {
	status, owner, severity, search, day, sort string
	limit                                      int
	cursor                                     *recoveryQueueCursor
}

// listRecoveryQueue runs the cap-correct join. Every leg is org-scoped;
// owner/severity filters key off the joined recovery item, so a dead
// letter without one is excluded by those filters (its joined columns
// are NULL → no match), mirroring the contract.
func (s *V1Server) listRecoveryQueue(ctx context.Context, orgID string, q recoveryQueueQuery) ([]recoveryQueueRow, error) {
	args := []any{orgID}
	arg := func(value any) string {
		args = append(args, value)
		return fmt.Sprintf("$%d", len(args))
	}
	// Validation-mode rows are dialog/drill evidence, not operator work.
	where := []string{"dl.org_id = $1", "dl.replay_mode IS NULL"}
	if q.status != "" {
		where = append(where, "dl.status = "+arg(q.status))
	}
	if q.owner != "" {
		where = append(where, "ri.owner = "+arg(q.owner))
	}
	if q.severity != "" {
		where = append(where, "ri.severity = "+arg(q.severity))
	}
	if start, end, ok := parseDayRange(q.day); q.day != "" && ok {
		where = append(where, "dl.created_at >= "+arg(start), "dl.created_at < "+arg(end))
	}
	if q.search != "" {
		pattern := arg("%" + escapeTextSearchLikePattern(q.search) + "%")
		where = append(where, fmt.Sprintf(
			"(dl.node_id || chr(31) || dl.run_id || chr(31) || COALESCE(dl.error_json->>'message', '')) ILIKE %s ESCAPE '\\'",
			pattern))
	}
	if c := q.cursor; c != nil {
		cAt, cID := arg(c.createdAt), arg(c.id)
		descTie := fmt.Sprintf("(dl.created_at < %s OR (dl.created_at = %s AND dl.id < %s))", cAt, cAt, cID)
		switch q.sort {
		case "oldest":
			where = append(where, fmt.Sprintf(
				"(dl.created_at > %s OR (dl.created_at = %s AND dl.id > %s))", cAt, cAt, cID))
		case "severity":
			if c.key == nil {
				where = append(where, "(ri.severity IS NULL AND "+descTie+")")
			} else {
				k := arg(*c.key)
				where = append(where, fmt.Sprintf(
					"(ri.severity > %s OR ri.severity IS NULL OR (ri.severity = %s AND %s))", k, k, descTie))
			}
		case "sla":
			if c.key == nil {
				where = append(where, "(ri.sla_target_at IS NULL AND "+descTie+")")
			} else {
				at, _ := time.Parse(time.RFC3339Nano, *c.key)
				k := arg(at)
				where = append(where, fmt.Sprintf(
					"(ri.sla_target_at > %s OR ri.sla_target_at IS NULL OR (ri.sla_target_at = %s AND %s))", k, k, descTie))
			}
		default:
			where = append(where, descTie)
		}
	}
	orderBy := "dl.created_at DESC, dl.id DESC"
	switch q.sort {
	case "oldest":
		orderBy = "dl.created_at ASC, dl.id ASC"
	case "severity":
		// Severity text sorts p1<p2<p3<p4 = rank order (most urgent first).
		orderBy = "ri.severity ASC NULLS LAST, dl.created_at DESC, dl.id DESC"
	case "sla":
		orderBy = "ri.sla_target_at ASC NULLS LAST, dl.created_at DESC, dl.id DESC"
	}
	limit := q.limit
	if limit <= 0 {
		limit = dlqListDefaultLimit
	}
	if limit > dlqListMaxLimit+1 {
		limit = dlqListMaxLimit
	}
	// Summary projection: workflow_json / node_json are unbounded
	// (replay-fidelity) columns the list never renders — ship one-field
	// ->> extractions instead; GET /dlq?id= returns the full row.
	query := `SELECT dl.id, dl.run_id, dl.node_id, dl.attempt, dl.error_json, dl.status,
  dl.replayed_at, dl.created_at, dl.node_json->>'type', dl.workflow_json->>'name',
  ri.id, ri.owner, ri.severity, ri.status, ri.sla_target_at, ri.resolution_reason,
  ri.comments, ri.workflow_id, wf.id, ri.occurrence_count, ri.last_occurred_at
FROM dead_letters dl
LEFT JOIN recovery_items ri ON ri.org_id = dl.org_id AND ri.dead_letter_id = dl.id
LEFT JOIN workflows wf ON wf.org_id = dl.org_id AND wf.id = ri.workflow_id
WHERE ` + strings.Join(where, " AND ") + `
ORDER BY ` + orderBy + `
LIMIT ` + arg(limit)

	dbRows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer dbRows.Close()
	rows := make([]recoveryQueueRow, 0, limit)
	for dbRows.Next() {
		var (
			id, runID, nodeID, status                            string
			attempt                                              int32
			errorJSON                                            []byte
			replayedAt, createdAt                                *time.Time
			nodeType, workflowName                               *string
			riID, riOwner, riSeverity, riStatus                  *string
			riSLATargetAt, riLastOccurredAt                      *time.Time
			riResolutionReason, riWorkflowID, metadataWorkflowID *string
			riComments                                           []byte
			riOccurrenceCount                                    *int32
		)
		if err := dbRows.Scan(&id, &runID, &nodeID, &attempt, &errorJSON, &status,
			&replayedAt, &createdAt, &nodeType, &workflowName,
			&riID, &riOwner, &riSeverity, &riStatus, &riSLATargetAt, &riResolutionReason,
			&riComments, &riWorkflowID, &metadataWorkflowID,
			&riOccurrenceCount, &riLastOccurredAt); err != nil {
			return nil, err
		}
		var recovery any
		if riID != nil {
			var comments any = json.RawMessage(riComments)
			recovery = map[string]any{
				"id": *riID, "owner": ptrOrNull(riOwner), "severity": deref(riSeverity),
				"status": deref(riStatus), "slaTargetAt": timePtrOrNull(riSLATargetAt),
				"resolutionReason": ptrOrNull(riResolutionReason), "comments": comments,
				"workflowId": ptrOrNull(riWorkflowID), "metadataWorkflowId": ptrOrNull(metadataWorkflowID),
				"occurrenceCount": derefInt(riOccurrenceCount), "lastOccurredAt": timePtrOrNull(riLastOccurredAt),
			}
		}
		rowCreatedAt := time.Unix(0, 0).UTC()
		if createdAt != nil {
			rowCreatedAt = *createdAt
		}
		rows = append(rows, recoveryQueueRow{
			view: map[string]any{
				"id": id, "orgId": orgID, "runId": runID, "nodeId": nodeID,
				"attempt": attempt, "errorJson": json.RawMessage(errorJSON), "status": status,
				"replayedAt": timePtrOrNull(replayedAt), "createdAt": timePtrOrNull(createdAt),
				"nodeType": ptrOrNull(nodeType), "workflowName": ptrOrNull(workflowName),
				"recovery": recovery,
			},
			id: id, createdAt: rowCreatedAt, severityKey: riSeverity, slaKey: riSLATargetAt,
		})
	}
	return rows, dbRows.Err()
}

func ptrOrNull(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func derefInt(value *int32) int32 {
	if value == nil {
		return 0
	}
	return *value
}

func timePtrOrNull(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.UTC()
}

// buildRecoveryQueuePage folds an over-fetched (pageSize+1) result into
// the {items, nextCursor, hasMore} envelope; nextCursor is non-nil
// exactly when hasMore.
func buildRecoveryQueuePage(overfetched []recoveryQueueRow, pageSize int, sort string) map[string]any {
	hasMore := len(overfetched) > pageSize
	rows := overfetched
	if hasMore {
		rows = overfetched[:pageSize]
	}
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		items = append(items, row.view)
	}
	var nextCursor any
	if hasMore && len(rows) > 0 {
		nextCursor = encodeRecoveryQueueCursor(sort, rows[len(rows)-1])
	}
	return map[string]any{"items": items, "nextCursor": nextCursor, "hasMore": hasMore}
}

// parseRecoveryQueueFilters validates the shared filter params; an
// out-of-enum value is a 400, not an empty page.
func (s *V1Server) parseRecoveryQueueFilters(r *http.Request, rc v1Request) (recoveryQueueQuery, *opResult) {
	params := r.URL.Query()
	q := recoveryQueueQuery{
		status: params.Get("status"), severity: params.Get("severity"),
		sort: params.Get("sort"), day: params.Get("day"),
	}
	if q.status != "" && !deadLetterStatuses[q.status] {
		res := opError(http.StatusBadRequest, "dlq_invalid_status", "Invalid DLQ status", nil)
		return q, &res
	}
	if q.severity != "" && !domain.RecoveryItemSeverities[q.severity] {
		res := opError(http.StatusBadRequest, "dlq_invalid_severity", "Invalid severity", nil)
		return q, &res
	}
	if q.sort != "" && !recoveryQueueSorts[q.sort] {
		res := opError(http.StatusBadRequest, "dlq_invalid_sort", "Invalid sort", nil)
		return q, &res
	}
	if q.sort == "" {
		q.sort = "newest"
	}
	// `owner=me` resolves to the caller's stable user id.
	if owner := strings.TrimSpace(params.Get("owner")); owner != "" {
		if owner == "me" {
			owner = rc.userID
		}
		q.owner = owner
	}
	search, bad := parseTextSearchQuery(params.Get("search"), "search")
	if bad != nil {
		return q, bad
	}
	q.search = search
	return q, nil
}

func (s *V1Server) recoveryQueueCore(r *http.Request, rc v1Request) opResult {
	q, bad := s.parseRecoveryQueueFilters(r, rc)
	if bad != nil {
		return *bad
	}
	pageSize := recoveryQueuePageDefault
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := parsePositiveInt(raw, recoveryQueuePageMax); err == nil {
			pageSize = n
		}
	}
	// Decode against the EFFECTIVE sort: a cursor minted under a different
	// sort is ignored (page 1), never mis-ordered.
	q.cursor = decodeRecoveryQueueCursor(r.URL.Query().Get("cursor"), q.sort)
	q.limit = pageSize + 1
	rows, err := s.listRecoveryQueue(r.Context(), rc.orgID, q)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	return opOK(buildRecoveryQueuePage(rows, pageSize, q.sort))
}

// dlqListItems is the bare-array form for the home preview: same join
// and filters, no cursor/day, flat array response (the legacy wire keeps
// bare /dlq an array by design, so the caller encodes it directly).
func (s *V1Server) dlqListItems(r *http.Request, rc v1Request) ([]map[string]any, *opResult) {
	q, bad := s.parseRecoveryQueueFilters(r, rc)
	if bad != nil {
		return nil, bad
	}
	q.day = ""
	q.limit = dlqListDefaultLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := parsePositiveInt(raw, dlqListMaxLimit); err == nil {
			q.limit = n
		}
	}
	rows, err := s.listRecoveryQueue(r.Context(), rc.orgID, q)
	if err != nil {
		res := opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
		return nil, &res
	}
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		items = append(items, row.view)
	}
	return items, nil
}

func (s *V1Server) mountRecoveryQueueRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /dlq/queue", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.recoveryQueueCore(r, rc))
	}))
}
