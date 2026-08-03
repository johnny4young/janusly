//go:build integration

package parity

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/httpapi"
)

// The semantic parity harness: every fixture in conformance/fixtures.json
// runs through the FULL Go stack (v1 API + engine + workers) and its
// projection must equal the golden captured from the reference — except
// where the accepted-divergences table below says otherwise.

// acceptedDivergences maps fixture id → projection-path → the value this
// backend produces instead of the reference's. Every entry documents WHY.
var acceptedDivergences = map[string]map[string]any{
	// Empty: F05 now re-arms the node at attempt 1, matching the
	// reference's recovery-claim posture.
}

type projection struct {
	RunStatus   string               `json:"runStatus"`
	Nodes       map[string]nodeShape `json:"nodes"`
	OutputJSON  any                  `json:"outputJson"`
	DeadLetters int                  `json:"deadLetters"`
}

type nodeShape struct {
	Status   string  `json:"status"`
	Attempts float64 `json:"attempts"`
}

type fixture struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Steps      []string        `json:"steps"`
	Input      map[string]any  `json:"input"`
	Ingest     map[string]any  `json:"ingest"`
	Workflow   json.RawMessage `json:"workflow"`
	WorkflowV2 json.RawMessage `json:"workflowV2"`
}

func TestSemanticParity(t *testing.T) {
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set; run through `make parity`")
	}
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")

	root := filepath.Join("..", "..", "conformance")
	rawSpec, err := os.ReadFile(filepath.Join(root, "fixtures.json"))
	if err != nil {
		t.Fatalf("fixtures: %v", err)
	}
	var spec struct {
		Fixtures []fixture `json:"fixtures"`
	}
	if err := json.Unmarshal(rawSpec, &spec); err != nil {
		t.Fatalf("fixtures decode: %v", err)
	}

	upstream := newStubUpstream(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()

	eng := engine.New(pool)
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stopWorkers := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = eng.RunWorkers(workerCtx, 4, 30*time.Millisecond, dispatcher.Execute,
			slog.New(slog.NewTextHandler(io.Discard, nil)))
	}()
	defer func() { stopWorkers(); <-done }()

	handler, shutdownHub := httpapi.NewV1HandlerWithShutdown(eng, pool)
	api := httptest.NewServer(handler)
	t.Cleanup(shutdownHub)
	defer api.Close()
	org := fmt.Sprintf("parity-go-%d", time.Now().UnixNano())
	driver := &apiDriver{base: api.URL, org: org}

	for _, fx := range spec.Fixtures {
		fx := fx
		t.Run(fx.ID+"_"+strings.ReplaceAll(fx.Name, " ", "_"), func(t *testing.T) {
			golden := loadGolden(t, filepath.Join(root, "goldens", "parity", fx.ID+".json"))
			got := runFixture(t, driver, upstream, fx)
			want := applyDivergences(golden, acceptedDivergences[fx.ID])
			if !reflect.DeepEqual(got, want) {
				gotJSON, _ := json.MarshalIndent(got, "", " ")
				wantJSON, _ := json.MarshalIndent(want, "", " ")
				t.Fatalf("projection parity broken\n got: %s\nwant: %s", gotJSON, wantJSON)
			}
		})
	}
}

func loadGolden(t *testing.T, path string) projection {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("golden %s: %v (generate with gen-goldens.mjs)", path, err)
	}
	var golden projection
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatalf("golden decode: %v", err)
	}
	return golden
}

func applyDivergences(golden projection, overrides map[string]any) projection {
	for path, value := range overrides {
		parts := strings.Split(path, ".")
		if len(parts) == 3 && parts[0] == "nodes" {
			node := golden.Nodes[parts[1]]
			if parts[2] == "attempts" {
				node.Attempts = value.(float64)
			}
			if parts[2] == "status" {
				node.Status = value.(string)
			}
			golden.Nodes[parts[1]] = node
		}
	}
	return golden
}

func runFixture(t *testing.T, driver *apiDriver, upstream *stubUpstream, fx fixture) projection {
	t.Helper()
	// {{RUN}} keeps stored-state fixtures (save + ingest) collision-free:
	// workflow ids are globally unique in the shared schema, so a static id
	// would leave cross-run residue owned by a previous test org.
	fill := strings.NewReplacer(
		"{{UPSTREAM}}", upstream.server.URL,
		"{{RUN}}", fmt.Sprintf("%d", time.Now().UnixNano()),
	)
	doc := json.RawMessage(fill.Replace(string(fx.Workflow)))
	var docV2 json.RawMessage
	if len(fx.WorkflowV2) > 0 {
		docV2 = json.RawMessage(fill.Replace(string(fx.WorkflowV2)))
	}
	var docID struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(doc, &docID)
	var runID, rolloutID string
	var savedVersions []string
	seenRuns := map[string]bool{}
	findDeadLetter := func() string {
		list := driver.call(t, "GET", "/v1/dlq?limit=50", nil)
		items, _ := list["data"].([]any)
		for _, item := range items {
			row := item.(map[string]any)
			if row["runId"] == runID {
				return row["id"].(string)
			}
		}
		t.Fatal("no dead letter for run")
		return ""
	}
	for _, step := range fx.Steps {
		verb, arg, _ := strings.Cut(step, ":")
		switch verb {
		case "save", "saveV2":
			body := doc
			if verb == "saveV2" {
				body = docV2
			}
			res := driver.call(t, "POST", "/v1/workflows/save", json.RawMessage(body))
			data, ok := res["data"].(map[string]any)
			if !ok {
				t.Fatalf("%s failed: %v", verb, res)
			}
			if versionID, ok := data["versionId"].(string); ok {
				savedVersions = append(savedVersions, versionID)
			}
		case "ingest":
			// The reference ingests org-wide by endpoint key; this backend
			// scopes the same contract to the workflow in the URL.
			var docID struct {
				ID string `json:"id"`
			}
			_ = json.Unmarshal(doc, &docID)
			res := driver.call(t, "POST", "/v1/webhooks/"+docID.ID, fx.Ingest)
			data, _ := res["data"].(map[string]any)
			runID, _ = data["runId"].(string)
			if runID == "" {
				t.Fatalf("ingest failed: %v", res)
			}
		case "start":
			body := map[string]any{"workflow": doc}
			if fx.Input != nil {
				body["input"] = fx.Input
			}
			res := driver.call(t, "POST", "/v1/start", body)
			data, _ := res["data"].(map[string]any)
			runID, _ = data["runId"].(string)
			if runID == "" {
				t.Fatalf("start failed: %v", res)
			}
			seenRuns[runID] = true
		case "startExpectPaused":
			// The breaker trips POST-commit (afterTerminalFailure), so a
			// start can race past the streak's last failure. Retry until
			// the 409 lands; an accidentally started run is one more
			// failure feeding the streak — wait it out and mark it seen so
			// adoptNewestRun can never grab it.
			deadline := time.Now().Add(15 * time.Second)
			for {
				res := driver.call(t, "POST", "/v1/start", map[string]any{"workflow": doc})
				if errBody, _ := res["error"].(map[string]any); errBody != nil {
					if errBody["code"] != "workflow_circuit_breaker_paused" {
						t.Fatalf("expected breaker 409, got %v", res)
					}
					break
				}
				data, _ := res["data"].(map[string]any)
				racedRun, _ := data["runId"].(string)
				if racedRun == "" {
					t.Fatalf("expected breaker 409, got %v", res)
				}
				seenRuns[racedRun] = true
				driver.waitRun(t, racedRun, func(view map[string]any) bool {
					status := runStatusOf(view)
					return status == "succeeded" || status == "failed" || status == "cancelled"
				})
				if time.Now().After(deadline) {
					t.Fatal("breaker never tripped")
				}
				time.Sleep(150 * time.Millisecond)
			}
		case "validateFix":
			deadLetterID := findDeadLetter()
			res := driver.call(t, "POST", "/v1/dlq/validate-fix", map[string]any{
				"deadLetterId": deadLetterID, "suggestedWorkflow": json.RawMessage(doc),
			})
			data, _ := res["data"].(map[string]any)
			runID, _ = data["runId"].(string)
			if runID == "" {
				t.Fatalf("validateFix failed: %v", res)
			}
			seenRuns[runID] = true
		case "ingestExpectBuffered":
			res := driver.call(t, "POST", "/v1/webhooks/"+docID.ID, fx.Ingest)
			data, _ := res["data"].(map[string]any)
			if data == nil || data["buffered"] != true {
				t.Fatalf("expected buffered ingest, got %v", res)
			}
		case "resumeWorkflow":
			res := driver.call(t, "POST", "/v1/workflows/"+docID.ID+"/resume", map[string]any{})
			if _, ok := res["data"]; !ok {
				t.Fatalf("resumeWorkflow failed: %v", res)
			}
		case "adoptNewestRun":
			deadline := time.Now().Add(20 * time.Second)
			for {
				res := driver.call(t, "GET", "/v1/runs?limit=50", nil)
				rows, _ := res["data"].([]any)
				adopted := ""
				for _, raw := range rows {
					row := raw.(map[string]any)
					if row["workflowId"] == docID.ID && !seenRuns[row["id"].(string)] {
						adopted = row["id"].(string)
						break
					}
				}
				if adopted != "" {
					runID = adopted
					seenRuns[runID] = true
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("backfilled run never appeared")
				}
				time.Sleep(200 * time.Millisecond)
			}
		case "waitRunWaiting":
			driver.waitRun(t, runID, func(view map[string]any) bool {
				return runStatusOf(view) == "waiting"
			})
		case "rolloutCreate":
			if len(savedVersions) < 2 {
				t.Fatal("rolloutCreate needs two saved versions")
			}
			res := driver.call(t, "POST", "/workflows/"+docID.ID+"/rollout", map[string]any{
				"baselineVersionId": savedVersions[0], "canaryVersionId": savedVersions[1],
				"trafficPercent": 20, "minimumSampleSize": 5, "minimumSuccessRatePercent": 90,
			})
			rollout, _ := res["rollout"].(map[string]any)
			if rollout == nil {
				t.Fatalf("rolloutCreate failed: %v", res)
			}
			rolloutID = rollout["id"].(string)
		case "rolloutPromote", "rolloutRollback":
			decision := "rollback"
			if verb == "rolloutPromote" {
				decision = "promote"
			}
			res := driver.call(t, "POST", "/workflows/"+docID.ID+"/rollout/"+rolloutID+"/"+decision, map[string]any{})
			if _, ok := res["rollout"]; !ok {
				t.Fatalf("%s failed: %v", verb, res)
			}
		case "clusterApplyFix":
			deadLetterID := findDeadLetter()
			clusters := driver.call(t, "GET", "/dlq/clusters", nil)
			clusterRows, _ := clusters["clusters"].([]any)
			if len(clusterRows) == 0 {
				t.Fatalf("no cluster signature: %v", clusters)
			}
			signature := clusterRows[0].(map[string]any)["signature"].(string)
			res := driver.call(t, "POST", "/dlq/cluster-apply", map[string]any{
				"clusterSignature": signature, "deadLetterIds": []any{deadLetterID},
				"suggestedWorkflow": json.RawMessage(docV2),
			})
			if res["replayed"] != float64(1) {
				t.Fatalf("clusterApplyFix failed: %v", res)
			}
		case "cancel":
			res := driver.call(t, "POST", "/v1/run/cancel", map[string]any{"runId": runID})
			if _, ok := res["data"]; !ok {
				t.Fatalf("cancel failed: %v", res)
			}
		case "waitTerminal":
			driver.waitRun(t, runID, func(view map[string]any) bool {
				status := runStatusOf(view)
				return status == "succeeded" || status == "failed" || status == "cancelled"
			})
		case "waitNodeWaiting":
			driver.waitRun(t, runID, func(view map[string]any) bool {
				return nodeStatus(view, arg) == "waiting"
			})
		case "resume":
			res := driver.call(t, "POST", "/v1/resume", map[string]any{"runId": runID, "nodeId": arg})
			if _, ok := res["data"]; !ok {
				t.Fatalf("resume failed: %v", res)
			}
		case "healUpstream":
			upstream.heal("/flaky-" + strings.ToLower(fx.ID))
		case "redrive":
			list := driver.call(t, "GET", "/v1/dlq?limit=50", nil)
			items, _ := list["data"].([]any)
			var deadLetterID string
			for _, item := range items {
				row := item.(map[string]any)
				if row["runId"] == runID {
					deadLetterID = row["id"].(string)
				}
			}
			if deadLetterID == "" {
				t.Fatal("no dead letter for run")
			}
			res := driver.call(t, "POST", "/v1/dlq/redrive", map[string]any{"deadLetterId": deadLetterID})
			if _, ok := res["data"]; !ok {
				t.Fatalf("redrive failed: %v", res)
			}
		default:
			t.Fatalf("unknown step %s", step)
		}
	}

	view := driver.runView(t, runID)
	nodes := map[string]nodeShape{}
	for _, raw := range view["nodes"].([]any) {
		node := raw.(map[string]any)
		attempts, _ := node["attempts"].(float64)
		nodes[node["nodeId"].(string)] = nodeShape{Status: node["status"].(string), Attempts: attempts}
	}
	run := view["run"].(map[string]any)
	list := driver.call(t, "GET", "/v1/dlq?limit=100", nil)
	deadLetters := 0
	for _, item := range list["data"].([]any) {
		if item.(map[string]any)["runId"] == runID {
			deadLetters++
		}
	}
	return projection{
		RunStatus:   run["status"].(string),
		Nodes:       nodes,
		OutputJSON:  run["outputJson"],
		DeadLetters: deadLetters,
	}
}

// ---- API driver -----------------------------------------------------------

type apiDriver struct {
	base string
	org  string
}

func (d *apiDriver) call(t *testing.T, method, path string, body any) map[string]any {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, d.base+path, reader)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-org-id", d.org)
	req.Header.Set("x-user-id", "parity")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	var parsed map[string]any
	_ = json.NewDecoder(res.Body).Decode(&parsed)
	return parsed
}

func (d *apiDriver) runView(t *testing.T, runID string) map[string]any {
	t.Helper()
	res := d.call(t, "GET", "/v1/run?runId="+runID, nil)
	data, ok := res["data"].(map[string]any)
	if !ok {
		t.Fatalf("run view missing: %v", res)
	}
	return data
}

func (d *apiDriver) waitRun(t *testing.T, runID string, predicate func(map[string]any) bool) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		view := d.runView(t, runID)
		if predicate(view) {
			return
		}
		if time.Now().After(deadline) {
			raw, _ := json.Marshal(view["run"])
			t.Fatalf("run %s: condition never met (%s)", runID, raw)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func runStatusOf(view map[string]any) string {
	run, _ := view["run"].(map[string]any)
	status, _ := run["status"].(string)
	return status
}

func nodeStatus(view map[string]any, nodeID string) string {
	nodes, _ := view["nodes"].([]any)
	for _, raw := range nodes {
		node := raw.(map[string]any)
		if node["nodeId"] == nodeID {
			return node["status"].(string)
		}
	}
	return ""
}

// ---- deterministic upstream stub (same behavior as the mjs generator) -----

type stubUpstream struct {
	server *httptest.Server
	mu     sync.Mutex
	healed map[string]bool
}

func newStubUpstream(t *testing.T) *stubUpstream {
	t.Helper()
	stub := &stubUpstream{healed: map[string]bool{}}
	stub.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case path == "/ok":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"healed":true,"source":"stub"}`))
		case path == "/fail":
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte("boom"))
		case strings.HasPrefix(path, "/flaky"):
			stub.mu.Lock()
			ok := stub.healed[path]
			stub.mu.Unlock()
			if ok {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"healed":true}`))
			} else {
				w.WriteHeader(http.StatusInternalServerError)
				_, _ = w.Write([]byte("still down"))
			}
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(stub.server.Close)
	return stub
}

func (s *stubUpstream) heal(path string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.healed[path] = true
}
