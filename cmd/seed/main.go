// go run ./cmd/seed: a deterministic demo org driven ENTIRELY through the
// public API with dev headers — never direct SQL — so what the seed
// creates is exactly what the product can create. Idempotent: workflows
// and credentials are create-if-missing, runs are topped up only until
// the org looks populated, and re-running is always safe.
//
//	JANUSLY_SEED_API   target API (default http://127.0.0.1:3001)
//	JANUSLY_SEED_ORG   org id (default demo-org)
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"
)

var (
	apiBase = envOr("JANUSLY_SEED_API", "http://127.0.0.1:3001")
	org     = envOr("JANUSLY_SEED_ORG", "demo-org")
)

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func call(method, path string, body any) (int, map[string]any) {
	var reader *bytes.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}
	request, err := http.NewRequest(method, apiBase+path, reader)
	if err != nil {
		fmt.Fprintln(os.Stderr, "request:", err)
		os.Exit(1)
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("x-org-id", org)
	request.Header.Set("x-user-id", "seed")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		fmt.Fprintln(os.Stderr, "seed: API unreachable at", apiBase, "— run `make run` first:", err)
		os.Exit(1)
	}
	defer func() { _ = response.Body.Close() }()
	var decoded map[string]any
	_ = json.NewDecoder(response.Body).Decode(&decoded)
	return response.StatusCode, decoded
}

func must(status int, decoded map[string]any) map[string]any {
	if status < 200 || status > 299 {
		fmt.Fprintf(os.Stderr, "seed: call failed: %d %+v\n", status, decoded)
		os.Exit(1)
	}
	return decoded
}

func ensureWorkflow(id string, doc map[string]any) {
	if status, _ := call("GET", "/v1/workflows/latest?workflowId="+id, nil); status == 200 {
		fmt.Println("  workflow", id, "already present")
		return
	}
	must(call("POST", "/workflows/save", doc))
	fmt.Println("  workflow", id, "saved")
}

func main() {
	fmt.Printf("seeding %s as org %q\n", apiBase, org)

	// 1. Dummy credentials (create-if-missing by name).
	_, credentials := call("GET", "/credentials", nil)
	existing := map[string]bool{}
	if rows, ok := credentials["credentials"].([]any); ok {
		for _, raw := range rows {
			if row, ok := raw.(map[string]any); ok {
				if name, ok := row["name"].(string); ok {
					existing[name] = true
				}
			}
		}
	}
	for name, kind := range map[string]string{
		"demo-slack": "slack", "demo-webhook": "webhook_secret",
	} {
		if existing[name] {
			fmt.Println("  credential", name, "already present")
			continue
		}
		status, decoded := call("POST", "/credentials", map[string]any{
			"name": name, "kind": kind, "secretValue": "demo-secret-" + name,
		})
		if status < 200 || status > 299 {
			fmt.Println("  credential", name, "skipped:", status, decoded["error"])
		} else {
			fmt.Println("  credential", name, "created")
		}
	}

	// 2. Deterministic workflows: a green pipeline, a subworkflow pair,
	//    a scheduled report, and a flaky ingest that dead-letters with a
	//    REPEATED signature.
	child := map[string]any{
		"id": "demo-child", "name": "Demo · child enrichment", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "enrich", "type": "transform",
			"config": map[string]any{"mapping": map[string]any{"enriched": "{{context.input.value}}-ok"}}}},
		"edges":   []any{},
		"outputs": map[string]any{"result": "{{context.enrich.output.enriched}}"},
	}
	ensureWorkflow("demo-child", child)
	ensureWorkflow("demo-pipeline", map[string]any{
		"id": "demo-pipeline", "name": "Demo · order pipeline", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "shape", "type": "transform",
				"config": map[string]any{"mapping": map[string]any{"total": "{{context.input.total}}"}}},
			map[string]any{"id": "tag", "type": "tool",
				"config": map[string]any{"tool": "text.uppercase", "input": map[string]any{"value": "order {{context.input.total}}"}}},
			map[string]any{"id": "done", "type": "noop", "config": map[string]any{}},
		},
		"edges": []any{
			map[string]any{"from": "shape", "to": "tag"},
			map[string]any{"from": "tag", "to": "done"},
		},
	})
	ensureWorkflow("demo-parent", map[string]any{
		"id": "demo-parent", "name": "Demo · parent with subworkflow", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "call", "type": "subworkflow",
				"config": map[string]any{"workflowId": "demo-child", "input": map[string]any{"value": "42"}}},
			map[string]any{"id": "after", "type": "transform",
				"config": map[string]any{"mapping": map[string]any{"got": "{{context.call.output.result}}"}}},
		},
		"edges": []any{map[string]any{"from": "call", "to": "after"}},
	})
	ensureWorkflow("demo-report", map[string]any{
		"id": "demo-report", "name": "Demo · nightly report", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "tick", "type": "schedule", "config": map[string]any{"cron": "0 3 * * *"}},
			map[string]any{"id": "build", "type": "noop", "config": map[string]any{}},
		},
		"edges": []any{map[string]any{"from": "tick", "to": "build"}},
	})
	ensureWorkflow("demo-flaky-ingest", map[string]any{
		"id": "demo-flaky-ingest", "name": "Demo · flaky ingest", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "fetch", "type": "http",
			// .invalid never resolves: a deterministic, repeatable failure
			// signature with zero SSRF surface.
			"config": map[string]any{"url": "https://demo-ingest.invalid/feed",
				"retry": map[string]any{"maxAttempts": 1}}}},
		"edges": []any{},
	})

	// 3. Runs: top up only when the org looks empty (idempotent-by-count).
	_, runsPage := call("GET", "/v1/runs?limit=50", nil)
	runCount := 0
	if data, ok := runsPage["data"].([]any); ok {
		runCount = len(data)
	}
	if runCount >= 6 {
		fmt.Printf("  runs already populated (%d) — skipping\n", runCount)
	} else {
		started := []string{}
		for i := range 3 {
			started = append(started, startSaved("demo-pipeline", map[string]any{"total": fmt.Sprint(100 + i)}))
		}
		started = append(started, startSaved("demo-parent", nil))
		// Two failures with the SAME signature → a DLQ cluster + incident.
		for range 2 {
			started = append(started, startSaved("demo-flaky-ingest", nil))
		}
		fmt.Printf("  started %d runs; waiting for terminal states…\n", len(started))
		deadline := time.Now().Add(60 * time.Second)
		for _, id := range started {
			for {
				_, statusBody := call("GET", "/v1/status?runId="+id, nil)
				status := ""
				if data, ok := statusBody["data"].(map[string]any); ok {
					if run, ok := data["run"].(map[string]any); ok {
						status, _ = run["status"].(string)
					}
				}
				if status == "succeeded" || status == "failed" || status == "cancelled" {
					break
				}
				if time.Now().After(deadline) {
					fmt.Println("  run", id, "did not settle in time (continuing)")
					break
				}
				time.Sleep(300 * time.Millisecond)
			}
		}
	}

	// 4. Summary: what the web will show.
	_, dlq := call("GET", "/v1/dlq", nil)
	dlqCount := 0
	if data, ok := dlq["data"].([]any); ok {
		dlqCount = len(data)
	}
	_, itemsPage := call("GET", "/recovery/items", nil)
	incidentCount := 0
	if rows, ok := itemsPage["items"].([]any); ok {
		incidentCount = len(rows)
	}
	fmt.Printf("seed complete: org %q — dlq rows %d, incidents %d\n", org, dlqCount, incidentCount)
	fmt.Println("open the web with x-org-id", org, "to browse the populated views")
}

// startSaved starts the LATEST saved version of a workflow: /start takes
// the document, so the seed reads it back through the same API the web
// uses (never a local copy — what got saved is what runs).
func startSaved(workflowID string, input map[string]any) string {
	latest := must(call("GET", "/v1/workflows/latest?workflowId="+workflowID, nil))
	var doc any
	if data, ok := latest["data"].(map[string]any); ok {
		doc = data["dagJson"]
	}
	if doc == nil {
		fmt.Fprintf(os.Stderr, "seed: no dagJson for %s: %+v\n", workflowID, latest)
		os.Exit(1)
	}
	body := map[string]any{"workflow": doc}
	if input != nil {
		body["input"] = input
	}
	return runID(must(call("POST", "/v1/start", body)))
}

func runID(decoded map[string]any) string {
	if id, ok := decoded["runId"].(string); ok {
		return id
	}
	if data, ok := decoded["data"].(map[string]any); ok {
		if id, ok := data["runId"].(string); ok {
			return id
		}
	}
	fmt.Fprintf(os.Stderr, "seed: no runId in %+v\n", decoded)
	os.Exit(1)
	return ""
}
