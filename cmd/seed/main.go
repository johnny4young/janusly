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
	"context"
	"fmt"
	"net/url"
	"os"
	"time"

	"github.com/johnny4young/janusly/internal/runbookclient"
)

var (
	apiBase = envOr("JANUSLY_SEED_API", "http://127.0.0.1:3001")
	org     = envOr("JANUSLY_SEED_ORG", "demo-org")
	client  *runbookclient.Client
)

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func call(method, path string, body any) (int, map[string]any) {
	status, decoded, err := client.DoJSON(context.Background(), method, path, body)
	if err != nil {
		fmt.Fprintln(os.Stderr, "seed: API call failed at", apiBase+":", err)
		os.Exit(1)
	}
	return status, decoded
}

func callArray(method, path string) (int, []map[string]any) {
	status, decoded, err := client.DoJSONArray(context.Background(), method, path, nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "seed: API call failed at", apiBase+":", err)
		os.Exit(1)
	}
	return status, decoded
}

func withQuery(path string, values url.Values) string {
	return path + "?" + values.Encode()
}

func must(status int, decoded map[string]any) map[string]any {
	if status < 200 || status > 299 {
		fmt.Fprintf(os.Stderr, "seed: call failed: %d %+v\n", status, decoded)
		os.Exit(1)
	}
	return decoded
}

func ensureWorkflow(id string, doc map[string]any) {
	if status, _ := call("GET", withQuery("/v1/workflows/latest", url.Values{"workflowId": {id}}), nil); status == 200 {
		fmt.Println("  workflow", id, "already present")
		return
	}
	must(call("POST", "/workflows/save", doc))
	fmt.Println("  workflow", id, "saved")
}

func main() {
	var err error
	client, err = runbookclient.New(runbookclient.Config{BaseURL: apiBase, OrgID: org, UserID: "seed"})
	if err != nil {
		fmt.Fprintln(os.Stderr, "seed: configuration:", err)
		os.Exit(1)
	}
	fmt.Printf("seeding %s as org %q\n", apiBase, org)

	// 1. Dummy credentials (create-if-missing by name).
	_, credentials := callArray("GET", "/credentials")
	existing := map[string]bool{}
	for _, row := range credentials {
		if name, ok := row["name"].(string); ok {
			existing[name] = true
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
			map[string]any{"id": "tick", "type": "schedule", "config": map[string]any{"cronExpression": "0 3 * * *"}},
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
				_, statusBody := call("GET", withQuery("/v1/status", url.Values{"runId": {id}}), nil)
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
	latest := must(call("GET", withQuery("/v1/workflows/latest", url.Values{"workflowId": {workflowID}}), nil))
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
