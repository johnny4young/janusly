// Command loadgen is the runtime's bounded local load generator. It drives
// three scenarios against the /v1 surface without retaining an unbounded
// latency slice in memory.
//
//	loadgen -base http://127.0.0.1:3001 -scenario start -vus 10 -duration 30s -allow-dev-auth
//	loadgen -base http://127.0.0.1:3001 -scenario list -vus 50 -duration 30s -allow-dev-auth
//	loadgen -base http://127.0.0.1:3001 -scenario diamond -vus 10 -duration 30s -allow-dev-auth
//
// Dev-header mode is opt-in and non-loopback targets require a second explicit
// opt-in. Output is one JSON summary on stdout.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	maxResponseBytes                 = 1 << 20
	maxLatencyMs                     = 90_000
	queueSnapshotAvailabilityMinimum = 0.995
	queueUnavailableConsecutiveLimit = 6
	minimumQueueProbeInterval        = 100 * time.Millisecond
	maximumQueueProbeInterval        = time.Minute
	maximumExactJSONInteger          = 1<<53 - 1
)

type queueObservabilitySummary struct {
	Probes                    int     `json:"probes"`
	ValidSnapshots            int     `json:"validSnapshots"`
	UnavailableSnapshots      int     `json:"unavailableSnapshots"`
	Availability              float64 `json:"availability"`
	MaxUnavailableConsecutive int     `json:"maxUnavailableConsecutive"`
	MaxActive                 int     `json:"maxActive"`
	MaxWaiting                int     `json:"maxWaiting"`
	MinimumAvailability       float64 `json:"minimumAvailability"`
	UnavailableLimit          int     `json:"unavailableConsecutiveLimit"`
	Passed                    bool    `json:"passed"`
	unavailableConsecutive    int
}

func nonNegativeJSONInteger(value any) (int, bool) {
	number, ok := value.(float64)
	if !ok || number < 0 || number != math.Trunc(number) || number > maximumExactJSONInteger {
		return 0, false
	}
	return int(number), true
}

func (summary *queueObservabilitySummary) record(snapshot map[string]any) error {
	summary.Probes++
	active, activeOK := nonNegativeJSONInteger(snapshot["active"])
	waiting, waitingOK := nonNegativeJSONInteger(snapshot["waiting"])
	if activeOK && waitingOK {
		if queue, present := snapshot["queue"]; present && queue == nil {
			return errors.New("queue snapshot mixed measured counts with queue:null")
		}
		summary.ValidSnapshots++
		summary.unavailableConsecutive = 0
		summary.MaxActive = max(summary.MaxActive, active)
		summary.MaxWaiting = max(summary.MaxWaiting, waiting)
		return nil
	}

	_, activePresent := snapshot["active"]
	_, waitingPresent := snapshot["waiting"]
	queue, queuePresent := snapshot["queue"]
	if !activePresent && !waitingPresent && queuePresent && queue == nil {
		summary.UnavailableSnapshots++
		summary.unavailableConsecutive++
		summary.MaxUnavailableConsecutive = max(
			summary.MaxUnavailableConsecutive,
			summary.unavailableConsecutive,
		)
		return nil
	}
	return errors.New("queue snapshot omitted or malformed non-negative integer counts")
}

func (summary *queueObservabilitySummary) finalize() {
	summary.MinimumAvailability = queueSnapshotAvailabilityMinimum
	summary.UnavailableLimit = queueUnavailableConsecutiveLimit
	if summary.Probes > 0 {
		summary.Availability = float64(summary.ValidSnapshots) / float64(summary.Probes)
	}
	summary.Passed = summary.Probes > 0 &&
		summary.ValidSnapshots+summary.UnavailableSnapshots == summary.Probes &&
		summary.Availability+1e-12 >= queueSnapshotAvailabilityMinimum &&
		summary.MaxUnavailableConsecutive <= queueUnavailableConsecutiveLimit
}

func monitorQueue(
	ctx context.Context,
	interval time.Duration,
	probe func(context.Context) (map[string]any, error),
	summary *queueObservabilitySummary,
) error {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		snapshot, err := probe(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("queue probe during load: %w", err)
		}
		if err := summary.record(snapshot); err != nil {
			return fmt.Errorf("queue probe during load: %w", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

type latencyHistogram struct {
	buckets   []atomic.Uint64
	count     atomic.Uint64
	errors    atomic.Uint64
	totalNano atomic.Uint64
	minNano   atomic.Uint64
	maxNano   atomic.Uint64
}

func newLatencyHistogram() *latencyHistogram {
	h := &latencyHistogram{buckets: make([]atomic.Uint64, maxLatencyMs+2)}
	h.minNano.Store(math.MaxUint64)
	return h
}

func (h *latencyHistogram) record(latency time.Duration, failed bool) {
	if latency < 0 {
		latency = 0
	}
	nanos := uint64(latency)
	bucket := int((latency + time.Millisecond - 1) / time.Millisecond)
	if bucket > maxLatencyMs {
		bucket = maxLatencyMs + 1
	}
	h.buckets[bucket].Add(1)
	h.count.Add(1)
	h.totalNano.Add(nanos)
	if failed {
		h.errors.Add(1)
	}
	for current := h.minNano.Load(); nanos < current && !h.minNano.CompareAndSwap(current, nanos); current = h.minNano.Load() {
	}
	for current := h.maxNano.Load(); nanos > current && !h.maxNano.CompareAndSwap(current, nanos); current = h.maxNano.Load() {
	}
}

func (h *latencyHistogram) percentile(p float64) float64 {
	count := h.count.Load()
	if count == 0 {
		return 0
	}
	rank := uint64(math.Ceil(p * float64(count)))
	if rank == 0 {
		rank = 1
	}
	var seen uint64
	for index := range h.buckets {
		seen += h.buckets[index].Load()
		if seen >= rank {
			return float64(index)
		}
	}
	return float64(maxLatencyMs + 1)
}

func (h *latencyHistogram) summary(elapsed time.Duration) map[string]any {
	count := h.count.Load()
	minimum := h.minNano.Load()
	if minimum == math.MaxUint64 {
		minimum = 0
	}
	rate := 0.0
	if elapsed > 0 {
		rate = float64(count) / elapsed.Seconds()
	}
	average := 0.0
	if count > 0 {
		average = float64(h.totalNano.Load()) / float64(count) / float64(time.Millisecond)
	}
	return map[string]any{
		"iterations": count,
		"errors":     h.errors.Load(),
		"errorRate":  ratio(h.errors.Load(), count),
		"ratePerSec": rate,
		"minMs":      float64(minimum) / float64(time.Millisecond),
		"avgMs":      average,
		"maxMs":      float64(h.maxNano.Load()) / float64(time.Millisecond),
		"p50Ms":      h.percentile(0.50),
		"p95Ms":      h.percentile(0.95),
		"p99Ms":      h.percentile(0.99),
	}
}

func ratio(numerator, denominator uint64) float64 {
	if denominator == 0 {
		return 0
	}
	return float64(numerator) / float64(denominator)
}

func validateBase(raw string, allowNonLoopback bool) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", fmt.Errorf("base must be an absolute HTTP(S) origin")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return "", fmt.Errorf("base must not include credentials, a path, query, or fragment")
	}
	host := parsed.Hostname()
	loopback := strings.EqualFold(host, "localhost")
	if ip := net.ParseIP(host); ip != nil {
		loopback = ip.IsLoopback()
	}
	if !loopback && !allowNonLoopback {
		return "", fmt.Errorf("non-loopback base requires -allow-non-loopback")
	}
	return strings.TrimSuffix(parsed.String(), "/"), nil
}

func validQueueProbeInterval(interval time.Duration) bool {
	return interval == 0 || (interval >= minimumQueueProbeInterval && interval <= maximumQueueProbeInterval)
}

type config struct {
	base, scenario, org, user, workflowName string
	vus                                     int
	duration                                time.Duration
	queueProbeInterval                      time.Duration
	allowDevAuth, allowNonLoopback          bool
}

func parseConfig() (config, error) {
	cfg := config{}
	flag.StringVar(&cfg.base, "base", "http://127.0.0.1:3001", "API origin")
	flag.StringVar(&cfg.scenario, "scenario", "start", "start | list | diamond")
	flag.IntVar(&cfg.vus, "vus", 10, "concurrent virtual users")
	flag.DurationVar(&cfg.duration, "duration", 30*time.Second, "load duration")
	flag.StringVar(&cfg.org, "org", fmt.Sprintf("load-%d", time.Now().UnixNano()), "organization id")
	flag.StringVar(&cfg.user, "user", "loadgen", "dev-header user id")
	flag.StringVar(&cfg.workflowName, "workflow-name", "Load soak workflow", "workflow name used by start scenarios")
	flag.DurationVar(&cfg.queueProbeInterval, "queue-probe-interval", 0, "operator queue snapshot cadence; 0 disables")
	flag.BoolVar(&cfg.allowDevAuth, "allow-dev-auth", false, "explicitly allow forgeable local dev headers")
	flag.BoolVar(&cfg.allowNonLoopback, "allow-non-loopback", false, "explicitly allow a non-loopback API origin")
	flag.Parse()

	var problems []string
	base, err := validateBase(cfg.base, cfg.allowNonLoopback)
	if err != nil {
		problems = append(problems, err.Error())
	} else {
		cfg.base = base
	}
	if cfg.scenario != "start" && cfg.scenario != "list" && cfg.scenario != "diamond" {
		problems = append(problems, "scenario must be start, list, or diamond")
	}
	if cfg.vus < 1 || cfg.vus > 500 {
		problems = append(problems, "vus must be in 1..500")
	}
	if cfg.duration < time.Second || cfg.duration > 24*time.Hour {
		problems = append(problems, "duration must be in 1s..24h")
	}
	if !validQueueProbeInterval(cfg.queueProbeInterval) {
		problems = append(problems, "queue-probe-interval must be 0 or in 100ms..1m")
	}
	if strings.TrimSpace(cfg.org) == "" || strings.TrimSpace(cfg.user) == "" || strings.TrimSpace(cfg.workflowName) == "" {
		problems = append(problems, "org, user, and workflow-name must be non-empty")
	}
	if !cfg.allowDevAuth {
		problems = append(problems, "local dev-header load requires -allow-dev-auth")
	}
	if len(problems) > 0 {
		return config{}, errors.New(strings.Join(problems, "; "))
	}
	return cfg, nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "loadgen:", err)
		os.Exit(2)
	}
}

func run() error {
	cfg, err := parseConfig()
	if err != nil {
		return err
	}
	transport := &http.Transport{
		MaxIdleConns:        512,
		MaxIdleConnsPerHost: 512,
		IdleConnTimeout:     90 * time.Second,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Timeout: 60 * time.Second, Transport: transport}
	queueClient := &http.Client{Timeout: 5 * time.Second, Transport: transport}
	recorder := newLatencyHistogram()
	var nodesCompleted atomic.Int64

	call := func(ctx context.Context, requestClient *http.Client, method, path string, body any) (map[string]any, error) {
		var raw []byte
		if body != nil {
			var marshalErr error
			raw, marshalErr = json.Marshal(body)
			if marshalErr != nil {
				return nil, marshalErr
			}
		}
		req, err := http.NewRequestWithContext(ctx, method, cfg.base+path, bytes.NewReader(raw))
		if err != nil {
			return nil, err
		}
		req.Header.Set("accept", "application/json")
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-org-id", cfg.org)
		req.Header.Set("x-user-id", cfg.user)
		res, err := requestClient.Do(req)
		if err != nil {
			return nil, err
		}
		responseBody, readErr := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes+1))
		closeErr := res.Body.Close()
		if readErr != nil {
			return nil, readErr
		}
		if closeErr != nil {
			return nil, closeErr
		}
		if len(responseBody) > maxResponseBytes {
			return nil, fmt.Errorf("response exceeds %d bytes", maxResponseBytes)
		}
		var parsed map[string]any
		if err := json.Unmarshal(responseBody, &parsed); err != nil {
			return nil, fmt.Errorf("decode status %d: %w", res.StatusCode, err)
		}
		if res.StatusCode >= 400 {
			return parsed, fmt.Errorf("status %d", res.StatusCode)
		}
		return parsed, nil
	}

	linear := map[string]any{
		"dslVersion": "1.0", "id": "load-linear", "name": cfg.workflowName,
		"nodes": []any{
			map[string]any{"id": "first", "type": "noop", "config": map[string]any{}},
			map[string]any{"id": "shape", "type": "transform", "config": map[string]any{
				"mapping": map[string]any{"verdict": "ok"},
			}},
		},
		"edges": []any{map[string]any{"from": "first", "to": "shape"}},
	}
	diamond := map[string]any{
		"dslVersion": "1.0", "id": "load-diamond", "name": cfg.workflowName,
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

	phaseContext, cancelPhase := context.WithCancel(context.Background())
	defer cancelPhase()

	runToTerminal := func(workflow map[string]any, nodes int64) {
		startAt := time.Now()
		pollDeadline := startAt.Add(90 * time.Second)
		res, err := call(phaseContext, client, "POST", "/v1/start", map[string]any{"workflow": workflow})
		if err != nil {
			recorder.record(time.Since(startAt), true)
			return
		}
		data, _ := res["data"].(map[string]any)
		runID, _ := data["runId"].(string)
		if runID == "" {
			recorder.record(time.Since(startAt), true)
			return
		}
		for {
			if phaseContext.Err() != nil {
				recorder.record(time.Since(startAt), true)
				return
			}
			if time.Now().After(pollDeadline) {
				recorder.record(time.Since(startAt), true)
				return
			}
			res, err := call(phaseContext, client, "GET", "/v1/status?runId="+url.QueryEscape(runID), nil)
			if err != nil {
				recorder.record(time.Since(startAt), true)
				return
			}
			data, _ := res["data"].(map[string]any)
			run, _ := data["run"].(map[string]any)
			switch run["status"] {
			case "succeeded":
				recorder.record(time.Since(startAt), false)
				nodesCompleted.Add(nodes)
				return
			case "failed", "cancelled":
				recorder.record(time.Since(startAt), true)
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
	}

	begun := time.Now()
	deadline := begun.Add(cfg.duration)
	queueSummary := queueObservabilitySummary{}
	var queueMonitorDone chan error
	if cfg.queueProbeInterval > 0 {
		queueMonitorDone = make(chan error, 1)
		go func() {
			err := monitorQueue(phaseContext, cfg.queueProbeInterval, func(ctx context.Context) (map[string]any, error) {
				return call(ctx, queueClient, "GET", "/system/queue", nil)
			}, &queueSummary)
			if err != nil {
				cancelPhase()
			}
			queueMonitorDone <- err
		}()
	}
	var wg sync.WaitGroup
	for range cfg.vus {
		wg.Go(func() {
			for time.Now().Before(deadline) && phaseContext.Err() == nil {
				switch cfg.scenario {
				case "start":
					runToTerminal(linear, 2)
				case "diamond":
					runToTerminal(diamond, 4)
				case "list":
					startAt := time.Now()
					_, err := call(phaseContext, client, "GET", "/v1/runs?limit=50", nil)
					recorder.record(time.Since(startAt), err != nil)
				}
			}
		})
	}
	wg.Wait()
	cancelPhase()
	if queueMonitorDone != nil {
		if err := <-queueMonitorDone; err != nil {
			return err
		}
		queueSummary.finalize()
	}
	elapsed := time.Since(begun)

	out := recorder.summary(elapsed)
	out["scenario"] = cfg.scenario
	out["vus"] = cfg.vus
	out["durationSec"] = elapsed.Seconds()
	out["requestedDurationSec"] = cfg.duration.Seconds()
	out["organization"] = cfg.org
	if cfg.queueProbeInterval > 0 {
		out["queueObservability"] = queueSummary
	}
	if cfg.scenario == "diamond" || cfg.scenario == "start" {
		out["nodesPerSec"] = float64(nodesCompleted.Load()) / elapsed.Seconds()
	}
	raw, err := json.Marshal(out)
	if err != nil {
		return err
	}
	fmt.Println(string(raw))
	return nil
}
