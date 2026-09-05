// Wire encoders + parsing helpers shared by every v1/legacy handler: the
// {apiVersion, requestId, data|error} envelope writers, bounded body decode,
// cursor/int parsing, and null projections.
package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/httpkit"
)

func writeV1Data(w http.ResponseWriter, requestID string, data any) {
	httpkit.WriteV1Data(w, requestID, data)
}

func writeV1Error(w http.ResponseWriter, requestID string, status int, code, message string, params map[string]any) {
	httpkit.WriteV1Error(w, requestID, status, code, message, params)
}

func decodeBody(r *http.Request, into any) error {
	return httpkit.DecodeBody(r, into)
}

func decodeBodyBounded(r *http.Request, into any, maxBytes int64) error {
	return httpkit.DecodeBodyBounded(r, into, maxBytes)
}

// decodeJSONRecord mirrors the contract's readJson + asRecord pair: it
// enforces the caller's byte cap, preserves the standard body errors, and
// converts valid non-object JSON into an empty record.
func decodeJSONRecord(r *http.Request, maxBytes int64) (map[string]any, *opResult) {
	raw, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, maxBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			rejection := opError(http.StatusRequestEntityTooLarge, "server_request_failed",
				fmt.Sprintf("Request body too large. Limit is %d bytes", maxBytes), nil)
			return nil, &rejection
		}
		rejection := opError(http.StatusBadRequest, "server_request_failed", "Invalid JSON body", nil)
		return nil, &rejection
	}
	if len(raw) == 0 {
		return map[string]any{}, nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		rejection := opError(http.StatusBadRequest, "server_request_failed", "Invalid JSON body", nil)
		return nil, &rejection
	}
	record, _ := value.(map[string]any)
	if record == nil {
		record = map[string]any{}
	}
	return record, nil
}

func readRawBody(w http.ResponseWriter, r *http.Request, maxBytes int64) ([]byte, bool) {
	return httpkit.ReadRawBody(w, r, maxBytes)
}

var unmarshalFieldPattern = regexp.MustCompile(`rawWorkflow\.(\w+)`)

// contractField turns a parse issue ("nodes: Invalid input...") into the
// golden's params.field value; Go's whole-document unmarshal errors name
// the struct field, which maps back to the wire field.
func contractField(issues []domain.Issue) string {
	if len(issues) == 0 {
		return ""
	}
	message := issues[0].Message
	if match := unmarshalFieldPattern.FindStringSubmatch(message); match != nil {
		return strings.ToLower(match[1][:1]) + match[1][1:]
	}
	field, _, _ := strings.Cut(message, ":")
	return field
}

func (s *V1Server) internal(w http.ResponseWriter, rc v1Request, _ error) {
	writeV1Error(w, rc.id, http.StatusInternalServerError, "internal_error", "Internal error", nil)
}

func parsePositiveInt(raw string, max int) (int, error) {
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("invalid")
	}
	if n > max {
		n = max
	}
	return n, nil
}

func timeFarFuture() time.Time { return time.Now().Add(24 * time.Hour) }

func parseEventsCursor(cursor string) (time.Time, string, bool) {
	at, id, found := strings.Cut(cursor, "|")
	if !found {
		return time.Time{}, "", false
	}
	parsed, err := time.Parse(time.RFC3339Nano, at)
	if err != nil {
		return time.Time{}, "", false
	}
	return parsed, id, true
}

func rawOrNull(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	return raw
}

func timeOrNull(t *time.Time) any { return httpkit.TimeOrNull(t) }

func textOrNull(t pgtype.Text) any { return httpkit.TextOrNull(t) }

func textOrNullString(t any) any {
	switch v := t.(type) {
	case string:
		// The list queries COALESCE a truly-absent aggregate to "" (sqlc
		// cannot infer lateral nullability); the wire restores the null.
		if v == "" {
			return nil
		}
		return v
	case *string:
		if v == nil {
			return nil
		}
		return *v
	case pgtype.Text:
		return textOrNull(v)
	default:
		return nil
	}
}

func nullableInt(v pgtype.Int4) any {
	if !v.Valid {
		return nil
	}
	return v.Int32
}

// resumeWorkflowCore serves POST /workflows/{id}/resume: the DELIBERATELY
// manual breaker resume — an operator asserts the fault is fixed, the
// flip audits who, and the pause's buffered trigger events drain
// oldest-first (capped page; repeated calls drain the rest). Other pause
// sources are distinct operator situations and reject.

func isUniqueViolation(err error) bool { return httpkit.IsUniqueViolation(err) }
