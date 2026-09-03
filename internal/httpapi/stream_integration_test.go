//go:build integration

package httpapi

import (
	"bufio"
	"net/http"
	"strings"
	"testing"
	"time"
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
			case strings.HasPrefix(line, "retry: "), strings.HasPrefix(line, ": "):
				// handshake / heartbeat lines — not frames
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

func TestStreamReplaysAndTailsLive(t *testing.T) {
	h := newAPIHarness(t)
	approval := map[string]any{
		"nodes": []any{
			map[string]any{"id": "gate", "type": "approval", "config": map[string]any{"message": "sse"}},
			map[string]any{"id": "after", "type": "noop", "config": map[string]any{}},
		},
		"edges": []any{map[string]any{"from": "gate", "to": "after"}},
	}
	started := h.call("POST", "/v1/start", map[string]any{"workflow": approval}, "")
	runID := started.body["data"].(map[string]any)["runId"].(string)

	// Wait for the pause so the catch-up has run.started + node.waiting.
	deadline := time.Now().Add(15 * time.Second)
	for {
		res := h.call("GET", "/v1/run?runId="+runID, nil, "")
		nodes, _ := res.body["data"].(map[string]any)["nodes"].([]any)
		waiting := false
		for _, n := range nodes {
			if n.(map[string]any)["status"] == "waiting" {
				waiting = true
			}
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("gate never waited")
		}
		time.Sleep(30 * time.Millisecond)
	}

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
	var lastID string
	for _, f := range replayed {
		if f.event == "run-event" && strings.Contains(f.data, "run.started") {
			sawStarted = true
		}
		if f.id != "" {
			lastID = f.id
		}
	}
	if !sawStarted {
		t.Fatalf("catch-up must replay from the beginning: %+v", replayed)
	}
	if !strings.Contains(lastID, "|") {
		t.Fatalf("frame ids must be composite cursors: %q", lastID)
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
