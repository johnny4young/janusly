package httpapi

import (
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// RunSnapshotView is shared by the versioned and unversioned run/status reads.
// Empty lists stay arrays, and nullable fields stay present on the wire.
type RunSnapshotView struct {
	Run           RunView        `json:"run"`
	Nodes         []RunNodeView  `json:"nodes"`
	Events        []RunEventView `json:"events"`
	EventsCursor  *string        `json:"eventsCursor"`
	EventsHasMore bool           `json:"eventsHasMore"`
}

type RunNodeView struct {
	ID         string          `json:"id"`
	RunID      string          `json:"runId"`
	NodeID     string          `json:"nodeId"`
	Status     string          `json:"status"`
	StateJSON  json.RawMessage `json:"stateJson"`
	ErrorJSON  json.RawMessage `json:"errorJson"`
	Attempts   *int32          `json:"attempts"`
	StartedAt  *string         `json:"startedAt"`
	FinishedAt *string         `json:"finishedAt"`
}

type RunEventView struct {
	ID        string          `json:"id"`
	RunID     string          `json:"runId"`
	NodeID    *string         `json:"nodeId"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt *string         `json:"createdAt"`
	HoldUntil *string         `json:"holdUntil"`
}

func nullableTextValue(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func nullableIntValue(value pgtype.Int4) *int32 {
	if !value.Valid {
		return nil
	}
	return &value.Int32
}

func nullableTimeValue(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Format("2006-01-02T15:04:05.000Z")
	return &formatted
}
