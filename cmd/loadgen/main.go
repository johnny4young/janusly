// Command loadgen is the runtime's self-contained load generator — the same
// three scenarios against either backend (they share the /v1 surface), no
// external tooling required.
//
//	loadgen -base http://localhost:4600 -scenario start  -vus 10 -duration 30s
//	loadgen -base http://localhost:4600 -scenario list   -vus 50 -duration 30s
//	loadgen -base http://localhost:4600 -scenario diamond -vus 10 -duration 30s
//
// Scenarios: start = POST /v1/start of a linear two-node workflow, polling
// /v1/status to terminal (latency = start→terminal); list = hot GET
// /v1/runs?limit=50; diamond = the F09 fan-out/fan-in, reporting completed
// node transitions per second. Output: one JSON summary on stdout.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"net/http"
	"os"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

type sample struct {
	latency time.Duration
	err     bool
}

func main() {
	base := flag.String("base", "http://127.0.0.1:4600", "API origin")
	scenario := flag.String("scenario", "start", "start | list | diamond")
	vus := flag.Int("vus", 10, "concurrent virtual users")
	duration := flag.Duration("duration", 30*time.Second, "load duration")
	org := flag.String("org", fmt.Sprintf("load-%d", time.Now().UnixNano()), "org id")
	flag.Parse()

	transport := &http.Transport{
		MaxIdleConns: 512, MaxIdleConnsPerHost: 512,
		IdleConnTimeout: 90 * time.Second,
	}
	client := &http.Client{Timeout: 60 * time.Second, Transport: transport}
	var mu sync.Mutex
	var samples []sample
	var nodesCompleted atomic.Int64

	record := func(latency time.Duration, err bool) {
		mu.Lock()
		samples = append(samples, sample{latency, err})
		mu.Unlock()
	}

	call := func(method, path string, body any) (map[string]any, error) {
		var reader *bytes.Reader
		if body != nil {
			raw, _ := json.Marshal(body)
			reader = bytes.NewReader(raw)
		} else {
			reader = bytes.NewReader(nil)
		}
		req, err := http.NewRequest(method, *base+path, reader)
		if err != nil {
			return nil, err
		}
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-org-id", *org)
		req.Header.Set("x-user-id", "loadgen")
		res, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		defer func() { _ = res.Body.Close() }()
		var parsed map[string]any
		_ = json.NewDecoder(res.Body).Decode(&parsed)
		if res.StatusCode >= 400 {
			return parsed, fmt.Errorf("status %d", res.StatusCode)
		}
		return parsed, nil
	}

	linear := map[string]any{
		"nodes": []any{
			map[string]any{"id": "first", "type": "noop", "config": map[string]any{}},
			map[string]any{"id": "shape", "type": "transform", "config": map[string]any{
				"mapping": map[string]any{"verdict": "ok"},
			}},
		},
		"edges": []any{map[string]any{"from": "first", "to": "shape"}},
	}
	diamond := map[string]any{
		"nodes": []any{
			map[string]any{"id": "root", "type": "noop", "config": map[string]any{}},
			map[string]any{"id": "left", "type": "transform", "config": map[string]any{"mapping": map[string]any{"side": "left"}}},
			map[string]any{"id": "right", "type": "transform", "config": map[string]any{"mapping": map[string]any{"side": "right"}}},
			map[string]any{"id": "join", "type": "transform", "config": map[string]any{"mapping": map[string]any{
				"l": "{{context.left.output.side}}", "r": "{{context.right.output.side}}",
			}}},
		},
		"edges": []any{
			map[string]any{"from": "root", "to": "left"},
			map[string]any{"from": "root", "to": "right"},
			map[string]any{"from": "left", "to": "join"},
			map[string]any{"from": "right", "to": "join"},
		},
	}

	runToTerminal := func(workflow map[string]any, nodes int64) {
		startAt := time.Now()
		pollDeadline := startAt.Add(90 * time.Second)
		res, err := call("POST", "/v1/start", map[string]any{"workflow": workflow})
		if err != nil {
			record(time.Since(startAt), true)
			return
		}
		data, _ := res["data"].(map[string]any)
		runID, _ := data["runId"].(string)
		if runID == "" {
			record(time.Since(startAt), true)
			return
		}
		for {
			if time.Now().After(pollDeadline) {
				record(time.Since(startAt), true)
				return
			}
			res, err := call("GET", "/v1/status?runId="+runID, nil)
			if err != nil {
				record(time.Since(startAt), true)
				return
			}
			run, _ := res["data"].(map[string]any)["run"].(map[string]any)
			switch run["status"] {
			case "succeeded":
				record(time.Since(startAt), false)
				nodesCompleted.Add(nodes)
				return
			case "failed", "cancelled":
				record(time.Since(startAt), true)
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
	}

	deadline := time.Now().Add(*duration)
	var wg sync.WaitGroup
	for v := 0; v < *vus; v++ {
		wg.Go(func() {
			for time.Now().Before(deadline) {
				switch *scenario {
				case "start":
					runToTerminal(linear, 2)
				case "diamond":
					runToTerminal(diamond, 4)
				case "list":
					startAt := time.Now()
					_, err := call("GET", "/v1/runs?limit=50", nil)
					record(time.Since(startAt), err != nil)
				default:
					fmt.Fprintln(os.Stderr, "unknown scenario", *scenario)
					os.Exit(2)
				}
			}
		})
	}
	begun := time.Now()
	wg.Wait()
	elapsed := time.Since(begun)

	sort.Slice(samples, func(i, j int) bool { return samples[i].latency < samples[j].latency })
	errs := 0
	for _, s := range samples {
		if s.err {
			errs++
		}
	}
	pct := func(p float64) float64 {
		if len(samples) == 0 {
			return math.NaN()
		}
		idx := max(int(math.Ceil(p*float64(len(samples))))-1, 0)
		return samples[idx].latency.Seconds() * 1000
	}
	out := map[string]any{
		"scenario": *scenario, "vus": *vus, "durationSec": elapsed.Seconds(),
		"iterations": len(samples), "errors": errs,
		"ratePerSec": float64(len(samples)) / elapsed.Seconds(),
		"p50Ms":      pct(0.50), "p95Ms": pct(0.95), "p99Ms": pct(0.99),
	}
	if *scenario == "diamond" || *scenario == "start" {
		out["nodesPerSec"] = float64(nodesCompleted.Load()) / elapsed.Seconds()
	}
	raw, _ := json.Marshal(out)
	fmt.Println(string(raw))
}
