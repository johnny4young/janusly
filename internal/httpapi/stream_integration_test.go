//go:build integration

package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/store"
)

// The SSE protocol end to end: open handshake, catch-up replay, live tail
// on resume, and cursor-based reconnect.

type sseFrame struct {
	id    string
	event string
	data  string
}

// sseConn owns ONE line-pump goroutine per connection — two concurrent
// readers on the same bufio.Reader would steal each other's lines.
type sseConn struct {
	lines chan string
	errs  chan error
}

func newSSEConn(reader *bufio.Reader) *sseConn {
	conn := &sseConn{lines: make(chan string, 256), errs: make(chan error, 1)}
	go func() {
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				conn.errs <- err
				return
			}
			conn.lines <- line
		}
	}()
	return conn
}

func readFrames(t *testing.T, conn *sseConn, until func([]sseFrame) bool, timeout time.Duration) []sseFrame {
	t.Helper()
	var frames []sseFrame
	current := sseFrame{}
	deadline := time.Now().Add(timeout)
	for {
		if until(frames) {
			return frames
		}
		select {
		case line := <-conn.lines:
			line = strings.TrimRight(line, "\n")
			// Unknown fields, including retry hints and heartbeat comments,
			// do not contribute to an event frame.
			switch {
			case line == "":
				if current.event != "" || current.data != "" {
					frames = append(frames, current)
				}
				current = sseFrame{}
			case strings.HasPrefix(line, "id: "):
				current.id = strings.TrimPrefix(line, "id: ")
			case strings.HasPrefix(line, "event: "):
				current.event = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				current.data = strings.TrimPrefix(line, "data: ")
			}
		case err := <-conn.errs:
			t.Fatalf("stream read: %v (frames so far: %d)", err, len(frames))
		case <-time.After(time.Until(deadline)):
			t.Fatalf("stream timeout; frames so far: %+v", frames)
		}
	}
}

func openStream(t *testing.T, h *apiHarness, runID, lastEventID string) *sseConn {
	t.Helper()
	req, _ := http.NewRequest("GET", h.server.URL+"/runs/"+runID+"/stream", nil)
	req.Header.Set("x-org-id", h.org)
	req.Header.Set("x-user-id", "sse")
	if lastEventID != "" {
		req.Header.Set("Last-Event-ID", lastEventID)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	t.Cleanup(func() { _ = res.Body.Close() })
	if res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("stream handshake: %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	return newSSEConn(bufio.NewReader(res.Body))
}

// startWaitingGate starts an approval run and returns once its gate waits,
// so the catch-up holds run.started and node.waiting.
func startWaitingGate(t *testing.T, h *apiHarness) string {
	t.Helper()
	approval := map[string]any{
		"nodes": []any{
			map[string]any{"id": "gate", "type": "approval", "config": map[string]any{"message": "sse"}},
			map[string]any{"id": "after", "type": "noop", "config": map[string]any{}},
		},
		"edges": []any{map[string]any{"from": "gate", "to": "after"}},
	}
	started := h.call("POST", "/v1/start", map[string]any{"workflow": approval}, "")
	runID := started.body["data"].(map[string]any)["runId"].(string)
	deadline := time.Now().Add(15 * time.Second)
	for {
		res := h.call("GET", "/v1/run?runId="+runID, nil, "")
		nodes, _ := res.body["data"].(map[string]any)["nodes"].([]any)
		for _, n := range nodes {
			if n.(map[string]any)["status"] == "waiting" {
				return runID
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("gate never waited")
		}
		time.Sleep(30 * time.Millisecond)
	}
}

func TestStreamReplaysAndTailsLive(t *testing.T) {
	h := newAPIHarness(t)
	runID := startWaitingGate(t, h)

	conn := openStream(t, h, runID, "")
	replayed := readFrames(t, conn, func(frames []sseFrame) bool {
		for _, f := range frames {
			if f.event == "run-event" && strings.Contains(f.data, "node.waiting") {
				return true
			}
		}
		return false
	}, 10*time.Second)
	sawStarted := false
	var lastID, legacyCursor string
	for _, f := range replayed {
		if f.event == "run-event" && strings.Contains(f.data, "run.started") {
			sawStarted = true
		}
		if f.id != "" {
			lastID = f.id
			var event struct{ ID, CreatedAt string }
			if err := json.Unmarshal([]byte(f.data), &event); err != nil {
				t.Fatalf("decode frame: %v", err)
			}
			legacyCursor = event.CreatedAt + "|" + event.ID
		}
	}
	if !sawStarted {
		t.Fatalf("catch-up must replay from the beginning: %+v", replayed)
	}
	if _, err := strconv.ParseInt(lastID, 10, 64); err != nil {
		t.Fatalf("frame ids must be sequence cursors: %q", lastID)
	}

	// Live tail: resume the gate and expect the resumed/succeeded frames to
	// arrive on the SAME connection.
	h.call("POST", "/v1/resume", map[string]any{"runId": runID, "nodeId": "gate"}, "")
	readFrames(t, conn, func(frames []sseFrame) bool {
		sawResumed, sawTerminal := false, false
		for _, f := range frames {
			if f.event == "run-event" && strings.Contains(f.data, "node.resumed") {
				sawResumed = true
			}
			if f.event == "run-status" && strings.Contains(f.data, "succeeded") {
				sawTerminal = true
			}
		}
		return sawResumed && sawTerminal
	}, 15*time.Second)

	// Reconnect from the cursor: only events AFTER it replay.
	reconnect := openStream(t, h, runID, lastID)
	afterCursor := readFrames(t, reconnect, func(frames []sseFrame) bool {
		for _, f := range frames {
			if f.event == "run-status" {
				return true
			}
		}
		return false
	}, 10*time.Second)
	for _, f := range afterCursor {
		if f.event == "run-event" && strings.Contains(f.data, "run.started") {
			t.Fatal("cursor reconnect must not replay run.started again")
		}
	}

	// A cursor from the earlier "<iso>|<id>" format resumes after its event,
	// and one naming an unknown event replays everything.
	legacy := replayedTypes(t, h, runID, legacyCursor)
	if slices.Contains(legacy, "run.started") || !slices.Contains(legacy, "node.resumed") {
		t.Fatalf("legacy cursor must resume after its event: %v", legacy)
	}
	unknown := replayedTypes(t, h, runID, "2026-01-01T00:00:00.000Z|missing")
	if !slices.Contains(unknown, "run.started") || !slices.Contains(unknown, "node.resumed") {
		t.Fatalf("unknown legacy cursor must replay from the beginning: %v", unknown)
	}
}

// replayedTypes reconnects a finished run's stream and returns the event types
// replayed before its status frame.
func replayedTypes(t *testing.T, h *apiHarness, runID, lastEventID string) []string {
	t.Helper()
	frames := readFrames(t, openStream(t, h, runID, lastEventID), func(frames []sseFrame) bool {
		return slices.ContainsFunc(frames, func(f sseFrame) bool { return f.event == "run-status" })
	}, 10*time.Second)
	var types []string
	for _, f := range frames {
		if f.event == "run-event" {
			var event struct{ Type string }
			if err := json.Unmarshal([]byte(f.data), &event); err != nil {
				t.Fatalf("decode frame: %v", err)
			}
			types = append(types, event.Type)
		}
	}
	return types
}

func TestStreamGuardsMatchRunReads(t *testing.T) {
	h := newAPIHarness(t)
	started := h.call("POST", "/v1/start", map[string]any{"workflow": makeLinearWorkflow("wf-sse-" + h.org)}, "")
	runID := started.body["data"].(map[string]any)["runId"].(string)
	// Unknown and cross-org: the same indistinguishable 403 as run reads.
	requireError(t, h.call("GET", "/runs/ghost/stream", nil, ""),
		403, "runs_forbidden", "Forbidden")
	requireError(t, h.call("GET", "/runs/"+runID+"/stream", nil, h.org+"-x"),
		403, "runs_forbidden", "Forbidden")
}

// The web stops reconnecting once it sees a terminal status and relies on the
// server ending the response, or the connection would stay open indefinitely.
func TestRunStreamEndsAfterTerminalStatus(t *testing.T) {
	h := newAPIHarness(t)
	started := h.call("POST", "/v1/start", map[string]any{"workflow": map[string]any{
		"nodes": []any{map[string]any{"id": "only", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}}, "")
	runID := started.body["data"].(map[string]any)["runId"].(string)

	conn := openStream(t, h, runID, "")
	readFrames(t, conn, func(frames []sseFrame) bool {
		for _, f := range frames {
			if f.event == "run-status" && strings.Contains(f.data, "succeeded") {
				return true
			}
		}
		return false
	}, 15*time.Second)

	deadline := time.After(streamTerminalGrace + 10*time.Second)
	for {
		select {
		case <-conn.lines:
		case err := <-conn.errs:
			if !errors.Is(err, io.EOF) {
				t.Fatalf("stream ended with %v, want EOF", err)
			}
			return
		case <-deadline:
			t.Fatal("stream stayed open after the terminal grace window")
		}
	}
}

func frameEventID(t *testing.T, frame sseFrame) string {
	t.Helper()
	var event struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(frame.data), &event); err != nil {
		t.Fatalf("decode frame %q: %v", frame.data, err)
	}
	return event.ID
}

func insertStreamEvent(ctx context.Context, tx pgx.Tx, org, runID, eventID string, at time.Time) error {
	if err := store.New(tx).InsertRunEventAt(ctx, store.InsertRunEventAtParams{
		ID: eventID, RunID: runID, OrgID: org,
		NodeID: pgtype.Text{String: "gate", Valid: true},
		Type:   "node.tick", Payload: json.RawMessage(`{}`), CreatedAt: &at,
	}); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `SELECT pg_notify('janusly_run_events', $1)`, runID)
	return err
}

// A step that stamps its event before a sibling but commits after it must
// still reach a client that is already tailing the stream.
func TestStreamDeliversEventCommittedAfterALaterStamp(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	runID := startWaitingGate(t, h)
	conn := openStream(t, h, runID, "")
	frames := readFrames(t, conn, func(frames []sseFrame) bool {
		return slices.ContainsFunc(frames, func(f sseFrame) bool { return strings.Contains(f.data, "node.waiting") })
	}, 10*time.Second)

	stampedAt := time.Now().UTC().Truncate(time.Millisecond)
	lateID, earlyID := "late-commit-"+h.org, "early-commit-"+h.org
	lateTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = lateTx.Rollback(ctx) }()
	if err := insertStreamEvent(ctx, lateTx, h.org, runID, lateID, stampedAt); err != nil {
		t.Fatalf("insert late commit: %v", err)
	}

	earlyPID := make(chan uint32, 1)
	earlyDone := make(chan error, 1)
	go func() {
		earlyDone <- pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
			earlyPID <- tx.Conn().PgConn().PID()
			return insertStreamEvent(ctx, tx, h.org, runID, earlyID, stampedAt.Add(3*time.Second))
		})
	}()
	pid := <-earlyPID
	committedFirst := false
	deadline := time.Now().Add(10 * time.Second)
	for blocked := false; !committedFirst && !blocked; {
		select {
		case err := <-earlyDone:
			if err != nil {
				t.Fatalf("early commit: %v", err)
			}
			committedFirst = true
		case <-time.After(20 * time.Millisecond):
			var waitType *string
			if err := pool.QueryRow(ctx, `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, pid).Scan(&waitType); err != nil {
				t.Fatalf("inspect early transaction: %v", err)
			}
			blocked = waitType != nil && *waitType == "Lock"
		}
		if time.Now().After(deadline) {
			t.Fatal("early transaction neither committed nor waited on a lock")
		}
	}
	if committedFirst {
		// The stream sends the later stamp and moves its cursor past stampedAt.
		frames = append(frames, readFrames(t, conn, func(next []sseFrame) bool {
			return slices.ContainsFunc(next, func(f sseFrame) bool { return strings.Contains(f.data, earlyID) })
		}, 10*time.Second)...)
	}
	if err := lateTx.Commit(ctx); err != nil {
		t.Fatalf("late commit: %v", err)
	}
	if !committedFirst {
		if err := <-earlyDone; err != nil {
			t.Fatalf("early commit: %v", err)
		}
	}
	frames = append(frames, readFrames(t, conn, func(next []sseFrame) bool {
		seen := map[string]bool{}
		for _, f := range append(slices.Clone(frames), next...) {
			if f.event == "run-event" {
				seen[frameEventID(t, f)] = true
			}
		}
		return seen[lateID] && seen[earlyID]
	}, 10*time.Second)...)

	var order []string
	previous := int64(0)
	for _, f := range frames {
		if f.event != "run-event" {
			continue
		}
		position, err := strconv.ParseInt(f.id, 10, 64)
		if err != nil || position <= previous {
			t.Fatalf("frame id %q must be an ascending sequence after %d", f.id, previous)
		}
		previous = position
		if id := frameEventID(t, f); id == lateID || id == earlyID {
			order = append(order, id)
		}
	}
	if !slices.Equal(order, []string{lateID, earlyID}) {
		t.Fatalf("stream must send events in commit order, got %v", order)
	}
}
