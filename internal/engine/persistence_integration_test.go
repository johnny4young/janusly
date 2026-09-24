//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/grammar"
)

func TestProcessPersistenceBoundsDispatchAndCompletionNotState(t *testing.T) {
	ctx, pool, _, org := newHarness(t)
	for _, cap := range []int{128, 512} {
		policy, err := grammar.NewPersister(cap)
		if err != nil {
			t.Fatal(err)
		}
		eng := New(pool, WithPersistence(policy))
		t.Setenv("JANUSLY_PERSIST_MAX_BYTES", "2")
		const secret = "resolved-persist-secret"
		wf := mustParse(t, `{"nodes":[{"id":"one","type":"noop","config":{"note":"{{secret.PROBE}}"}}],"edges":[]}`)
		dispatcher := eng.NewDispatcher(grammar.RenderOptions{LookupSecret: func(name string) (string, bool) { return secret, name == "PROBE" }})
		dispatcher.registry["noop"] = func(_ context.Context, in executors.Input) (any, error) {
			in.Emit("policy.probe", map[string]any{"a": secret, "blob": strings.Repeat("x", 5000)})
			return map[string]any{"blob": strings.Repeat("x", 5000), "authorization": "key-secret"}, nil
		}
		runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
		if err != nil {
			t.Fatal(err)
		}
		claim := ClaimedNode{RunID: runID, NodeID: "one", OrgID: org}
		if err := pool.QueryRow(ctx, `UPDATE run_nodes SET status='running',started_at=now() WHERE run_id=$1 RETURNING id,attempts`, runID).Scan(&claim.RowID, &claim.Attempt); err != nil {
			t.Fatal(err)
		}
		eng.executeClaim(ctx, claim, dispatcher.Execute, quietLogger())
		for _, event := range []string{"policy.probe", "node.succeeded"} {
			var raw []byte
			if err := pool.QueryRow(ctx, `SELECT payload FROM run_events WHERE run_id=$1 AND type=$2`, runID, event).Scan(&raw); err != nil {
				t.Fatal(err)
			}
			var data map[string]any
			if err := json.Unmarshal(raw, &data); err != nil {
				t.Fatal(err)
			}
			compact, err := json.Marshal(data)
			if err != nil {
				t.Fatal(err)
			}
			if len(compact) > cap || data["maxBytes"] != float64(cap) || data["__truncated"] != true {
				t.Fatalf("%s cap%d: %s", event, cap, raw)
			}
			if strings.Contains(string(raw), secret) || strings.Contains(string(raw), "key-secret") {
				t.Fatalf("secret leaked: %s", raw)
			}
			if event == "policy.probe" && !strings.Contains(fmt.Sprint(data["preview"]), grammar.RedactedPlaceholder) {
				t.Fatalf("missing resolved redaction in bounded preview: %s", raw)
			}
		}
		var blob, authorization, status string
		if err := pool.QueryRow(ctx, `SELECT state_json->'output'->>'blob',state_json->'output'->>'authorization',status FROM run_nodes WHERE run_id=$1`, runID).Scan(&blob, &authorization, &status); err != nil {
			t.Fatal(err)
		}
		if len(blob) != 5000 || authorization != grammar.RedactedPlaceholder || status != "succeeded" {
			t.Fatalf("state was bounded by default or not redacted: bytes=%d authorization=%s status=%s", len(blob), authorization, status)
		}
	}
}
