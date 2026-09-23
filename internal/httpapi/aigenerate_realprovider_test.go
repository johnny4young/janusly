//go:build realprovider

package httpapi

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/johnny4young/janusly/internal/ai"
	"github.com/johnny4young/janusly/internal/aidiagnosis"
	"github.com/johnny4young/janusly/internal/authoring"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/engine"
)

const (
	realProviderMaxCalls        = 40
	realProviderMaxCallsPerCase = 2
	realProviderCaseCount       = 20
	realProviderUsefulMinimum   = 18
	realProviderDefaultMaxUSD   = 3.0
	realProviderOutputUnits     = 1200
)

type qualificationCallEvidence struct {
	Attempt      int      `json:"attempt"`
	Provider     string   `json:"provider"`
	Model        string   `json:"model"`
	InputTokens  int      `json:"inputTokens"`
	OutputTokens int      `json:"outputTokens"`
	TotalTokens  int      `json:"totalTokens"`
	LatencyMs    int64    `json:"latencyMs"`
	CostUSD      *float64 `json:"costUsd"`
	Result       string   `json:"result"`
}

type qualificationCaseEvidence struct {
	ID       string                      `json:"id"`
	Category string                      `json:"category"`
	Language string                      `json:"language"`
	Calls    []qualificationCallEvidence `json:"calls"`
	Valid    bool                        `json:"valid"`
	Safe     bool                        `json:"safe"`
	Useful   bool                        `json:"useful"`
	Repaired bool                        `json:"repaired"`
	Guarded  bool                        `json:"guarded,omitempty"`
	Result   string                      `json:"result"`
}

type qualificationReport struct {
	SchemaVersion   string                      `json:"schemaVersion"`
	Profile         string                      `json:"profile"`
	Model           string                      `json:"model"`
	Cases           []qualificationCaseEvidence `json:"cases"`
	CaseCount       int                         `json:"caseCount"`
	ValidCases      int                         `json:"validCases"`
	SafeCases       int                         `json:"safeCases"`
	UsefulCases     int                         `json:"usefulCases"`
	UsefulMinimum   int                         `json:"usefulMinimum"`
	Calls           int                         `json:"calls"`
	LifetimeCalls   int                         `json:"lifetimeCalls"`
	MaxCalls        int                         `json:"maxCalls"`
	MaxCallsPerCase int                         `json:"maxCallsPerCase"`
	Tokens          int                         `json:"tokens"`
	CostUSD         float64                     `json:"costUsd"`
	ReservedUSD     float64                     `json:"reservedUsd"`
	MaxUSD          float64                     `json:"maxUsd"`
	SDKRetries      int                         `json:"sdkRetries"`
	Breakers        map[string]bool             `json:"breakers"`
}

type recordedProviderCall struct {
	caseID, category string
	evidence         qualificationCallEvidence
}

// boundedProductClient checks both in-process and lifetime call caps. Before
// every external call it durably reserves a conservative byte-as-token upper
// bound; uncertain outcomes never refund a reservation automatically.
type boundedProductClient struct {
	delegate         ai.Client
	ledger           realProviderLedger
	maxCalls         int
	maxCallsPerCase  int
	maxUSD           float64
	defaultMaxOutput int

	mu            sync.Mutex
	calls         int
	tokens        int
	costUSD       float64
	reservedUSD   float64
	lifetimeCalls int
	records       []recordedProviderCall
}

func (c *boundedProductClient) Configured() bool { return c.delegate != nil && c.delegate.Configured() }

func (c *boundedProductClient) GenerateText(ctx context.Context, input ai.GenerateTextInput) (*ai.GenerateTextResult, *ai.AIError) {
	return c.generateForCase(ctx, "unscoped", "unscoped", 1, input)
}

func (c *boundedProductClient) generateForCase(
	ctx context.Context,
	caseID, category string,
	attempt int,
	input ai.GenerateTextInput,
) (*ai.GenerateTextResult, *ai.AIError) {
	provider, model := providerModel(input.ModelHint)
	// The approved budget is for this first-party model at its verified
	// catalog price. A local price override could make both reservations and
	// reported cost smaller without changing the provider's actual bill.
	if provider != "anthropic" || model != ai.DefaultModel {
		return nil, &ai.AIError{Class: "invalid_request", Message: "real-provider qualification requires the approved Anthropic model", BeforeEgress: true}
	}
	priceOverrideKey := "JANUSLY_LLM_PRICE_" + strings.ToUpper(strings.ReplaceAll(ai.DefaultModel, "-", "_"))
	if _, overridden := os.LookupEnv(priceOverrideKey); overridden {
		return nil, &ai.AIError{Class: "invalid_request", Message: "real-provider qualification does not accept model price overrides", BeforeEgress: true}
	}
	maxOutput := c.defaultMaxOutput
	if input.MaxOutputUnits > 0 {
		maxOutput = input.MaxOutputUnits
	}
	price := ai.GetModelPrice(model)
	if price == nil {
		return nil, &ai.AIError{Class: "invalid_request", Message: "real-provider qualification requires a known price"}
	}
	// UTF-8 byte count is deliberately more conservative than normal token
	// estimates. The fixed overhead covers provider framing and metadata.
	// All input might be charged at the cache-write tier, which can exceed
	// ordinary input pricing. Count every UTF-8 byte as one token plus a
	// 4096-token framing allowance; unused reserves are not refunded.
	inputRate := math.Max(price.InputUsdPer1M, math.Max(price.CacheWrite5mUsdPer1M, price.CacheReadUsdPer1M))
	projectedUSD := (float64(len(input.System)+len(input.Prompt)+4096)*inputRate +
		float64(maxOutput)*price.OutputUsdPer1M) / 1_000_000
	c.mu.Lock()
	if c.calls >= c.maxCalls {
		c.mu.Unlock()
		return nil, &ai.AIError{Class: "invalid_request", Message: "real-provider qualification call cap reached"}
	}
	perCaseCap := c.maxCallsPerCase
	if perCaseCap <= 0 {
		perCaseCap = realProviderMaxCallsPerCase
	}
	totals, err := c.ledger.reserve(caseID, projectedUSD, c.maxUSD, c.maxCalls, perCaseCap)
	if err != nil {
		c.mu.Unlock()
		return nil, &ai.AIError{Class: "invalid_request", Message: "real-provider qualification lifetime reservation refused"}
	}
	c.calls++
	c.reservedUSD = float64(totals.ReservedMicros) / 1_000_000
	c.lifetimeCalls = totals.Calls
	c.mu.Unlock()

	result, aiErr := c.delegate.GenerateText(ctx, input)
	evidence := qualificationCallEvidence{Attempt: attempt, Provider: provider, Model: model, Result: "ok"}
	if result != nil {
		evidence.Provider, evidence.Model = result.Provider, result.Model
		evidence.InputTokens = result.Usage.InputTokens
		evidence.OutputTokens = result.Usage.OutputTokens
		evidence.TotalTokens = result.Usage.TotalTokens
		evidence.LatencyMs = result.LatencyMs
		evidence.CostUSD = result.CostUsd
	}
	if aiErr != nil {
		evidence.Result = "error:" + aiErr.Class
	}
	c.mu.Lock()
	if result != nil {
		c.tokens += result.Usage.TotalTokens
		if result.CostUsd != nil {
			c.costUSD += *result.CostUsd
		}
	}
	c.records = append(c.records, recordedProviderCall{caseID: caseID, category: category, evidence: evidence})
	c.mu.Unlock()
	return result, aiErr
}

func (c *boundedProductClient) caseCalls(caseID string) []qualificationCallEvidence {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := []qualificationCallEvidence{}
	for _, record := range c.records {
		if record.caseID == caseID {
			out = append(out, record.evidence)
		}
	}
	return out
}

func (c *boundedProductClient) accounting() (calls, tokens int, cost float64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls, c.tokens, c.costUSD
}

func (c *boundedProductClient) reservations() (float64, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.reservedUSD, c.lifetimeCalls
}

type boundedCaseClient struct {
	global           *boundedProductClient
	caseID, category string
	mu               sync.Mutex
	attempts         int
}

type qualificationFakeClient struct {
	mu    sync.Mutex
	calls int
}

func (c *qualificationFakeClient) Configured() bool { return true }

func (c *qualificationFakeClient) GenerateText(_ context.Context, _ ai.GenerateTextInput) (*ai.GenerateTextResult, *ai.AIError) {
	c.mu.Lock()
	c.calls++
	c.mu.Unlock()
	cost := 0.001
	return &ai.GenerateTextResult{
		Text: "{}", Provider: "anthropic", Model: ai.DefaultModel,
		Usage:     ai.Usage{InputTokens: 100, OutputTokens: 20, TotalTokens: 120},
		LatencyMs: 1, CostUsd: &cost,
	}, nil
}

func (c *boundedCaseClient) Configured() bool { return c.global.Configured() }

func (c *boundedCaseClient) GenerateText(ctx context.Context, input ai.GenerateTextInput) (*ai.GenerateTextResult, *ai.AIError) {
	c.mu.Lock()
	maxAttempts := c.global.maxCallsPerCase
	if maxAttempts <= 0 {
		maxAttempts = realProviderMaxCallsPerCase
	}
	if c.attempts >= maxAttempts {
		c.mu.Unlock()
		return nil, &ai.AIError{Class: "invalid_request", Message: "real-provider per-case call cap reached"}
	}
	c.attempts++
	attempt := c.attempts
	c.mu.Unlock()
	return c.global.generateForCase(ctx, c.caseID, c.category, attempt, input)
}

func providerModel(hint string) (string, string) {
	provider, model := "anthropic", ai.DefaultModel
	if trimmed := strings.TrimSpace(hint); trimmed != "" {
		if explicitProvider, explicitModel, ok := strings.Cut(trimmed, "/"); ok {
			provider, model = explicitProvider, explicitModel
		} else {
			model = trimmed
		}
	}
	return provider, model
}

func TestRealProviderQualificationBreakersProviderFree(t *testing.T) {
	delegate := &qualificationFakeClient{}
	ledgerPath := t.TempDir() + "/ledger.jsonl"
	global := &boundedProductClient{
		delegate: delegate, maxCalls: realProviderMaxCalls, maxUSD: 1,
		ledger:           realProviderLedger{path: ledgerPath},
		defaultMaxOutput: realProviderOutputUnits,
	}
	client := &boundedCaseClient{global: global, caseID: "case", category: "authoring"}
	for attempt := range realProviderMaxCallsPerCase {
		if _, aiErr := client.GenerateText(t.Context(), ai.GenerateTextInput{System: "bounded", Prompt: "bounded"}); aiErr != nil {
			t.Fatalf("allowed call %d failed: %v", attempt+1, aiErr)
		}
	}
	if _, aiErr := client.GenerateText(t.Context(), ai.GenerateTextInput{System: "bounded", Prompt: "bounded"}); aiErr == nil || aiErr.Class != "invalid_request" {
		t.Fatalf("third per-case call must be refused locally: %v", aiErr)
	}
	if calls, _, _ := global.accounting(); calls != 2 || delegate.calls != 2 {
		t.Fatalf("per-case breaker reached provider calls=%d delegate=%d", calls, delegate.calls)
	}
	// Two Haiku 4.5 calls reserve 4110 input-byte tokens each at the 5-minute
	// cache-write rate ($1.25/M), plus 1200 output tokens at $5/M. Each
	// 11137.5-microUSD projection rounds upward before it is persisted.
	if reservedUSD, lifetimeCalls := global.reservations(); int64(math.Round(reservedUSD*1_000_000)) != 22_276 || lifetimeCalls != 2 {
		t.Fatalf("durable cache-tier upper bound missing: reserved=%f lifetimeCalls=%d", reservedUSD, lifetimeCalls)
	}
	restartedDelegate := &qualificationFakeClient{}
	restarted := &boundedProductClient{
		delegate: restartedDelegate, maxCalls: realProviderMaxCalls, maxCallsPerCase: 2, maxUSD: 1,
		ledger: realProviderLedger{path: ledgerPath}, defaultMaxOutput: realProviderOutputUnits,
	}
	if _, aiErr := (&boundedCaseClient{global: restarted, caseID: "case"}).GenerateText(t.Context(), ai.GenerateTextInput{}); aiErr == nil || restartedDelegate.calls != 0 {
		t.Fatalf("restart must not regain paid attempts: error=%v delegateCalls=%d", aiErr, restartedDelegate.calls)
	}

	usdBlockedDelegate := &qualificationFakeClient{}
	usdBlocked := &boundedProductClient{
		delegate: usdBlockedDelegate, maxCalls: realProviderMaxCalls, maxUSD: 0.0001,
		ledger:           realProviderLedger{path: t.TempDir() + "/ledger.jsonl"},
		defaultMaxOutput: realProviderOutputUnits,
	}
	if _, aiErr := usdBlocked.GenerateText(t.Context(), ai.GenerateTextInput{System: "bounded", Prompt: "bounded"}); aiErr == nil || aiErr.Class != "invalid_request" {
		t.Fatalf("USD preflight must fail closed: %v", aiErr)
	}
	if calls, _, _ := usdBlocked.accounting(); calls != 0 || usdBlockedDelegate.calls != 0 {
		t.Fatalf("USD breaker reached provider calls=%d delegate=%d", calls, usdBlockedDelegate.calls)
	}

	callBlockedDelegate := &qualificationFakeClient{}
	callBlocked := &boundedProductClient{
		delegate: callBlockedDelegate, maxCalls: 1, maxUSD: 1,
		ledger:           realProviderLedger{path: t.TempDir() + "/ledger.jsonl"},
		defaultMaxOutput: realProviderOutputUnits,
	}
	if _, aiErr := callBlocked.GenerateText(t.Context(), ai.GenerateTextInput{}); aiErr != nil {
		t.Fatal(aiErr)
	}
	if _, aiErr := callBlocked.GenerateText(t.Context(), ai.GenerateTextInput{}); aiErr == nil || aiErr.Class != "invalid_request" {
		t.Fatalf("global call breaker must refuse call two: %v", aiErr)
	}
	if callBlockedDelegate.calls != 1 {
		t.Fatalf("global breaker reached delegate %d times", callBlockedDelegate.calls)
	}
}

func TestRealProviderQualificationRejectsPriceOverrideAndWrongModelBeforeEgress(t *testing.T) {
	for _, testCase := range []struct {
		name      string
		modelHint string
		override  string
	}{
		{name: "price override", override: "0.000001,0.000001"},
		{name: "other Anthropic model", modelHint: "anthropic/claude-sonnet-4-5"},
		{name: "other provider", modelHint: "openai/claude-haiku-4-5-20251001"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if testCase.override != "" {
				t.Setenv("JANUSLY_LLM_PRICE_CLAUDE_HAIKU_4_5_20251001", testCase.override)
			}
			delegate := &qualificationFakeClient{}
			global := &boundedProductClient{
				delegate: delegate, maxCalls: realProviderMaxCalls, maxUSD: realProviderDefaultMaxUSD,
				ledger:           realProviderLedger{path: t.TempDir() + "/ledger.jsonl"},
				defaultMaxOutput: realProviderOutputUnits,
			}
			_, aiErr := global.GenerateText(t.Context(), ai.GenerateTextInput{ModelHint: testCase.modelHint})
			if aiErr == nil || aiErr.Class != "invalid_request" || delegate.calls != 0 {
				t.Fatalf("unqualified pricing/model reached delegate: error=%v calls=%d", aiErr, delegate.calls)
			}
			if calls, _, _ := global.accounting(); calls != 0 {
				t.Fatalf("unqualified pricing/model consumed a reservation: calls=%d", calls)
			}
		})
	}
}

// TestWorkflowAssuranceRealAnthropicEvaluation runs the exact 20-case corpus
// against Janusly's production authoring and diagnosis chokepoints. It is
// absent from ordinary CI and requires explicit paid-provider consent.
func TestWorkflowAssuranceRealAnthropicEvaluation(t *testing.T) {
	if os.Getenv("JANUSLY_REAL_PROVIDER_CONSENT") != "1" {
		t.Fatal("real provider test requires JANUSLY_REAL_PROVIDER_CONSENT=1")
	}
	key := strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY"))
	if key == "" {
		t.Fatal("ANTHROPIC_API_KEY is required for the explicit realprovider profile")
	}
	maxUSD := realProviderDefaultMaxUSD
	if raw := os.Getenv("JANUSLY_REAL_PROVIDER_MAX_USD"); raw != "" {
		parsed, err := strconv.ParseFloat(raw, 64)
		if err != nil || parsed <= 0 || parsed > realProviderDefaultMaxUSD {
			t.Fatalf("JANUSLY_REAL_PROVIDER_MAX_USD must be in (0,3], got %q", raw)
		}
		maxUSD = parsed
	}
	maxCalls := qualificationIntegerLimit(t, "JANUSLY_REAL_PROVIDER_MAX_CALLS", realProviderMaxCalls, realProviderCaseCount, realProviderMaxCalls)
	maxCallsPerCase := qualificationIntegerLimit(t, "JANUSLY_REAL_PROVIDER_MAX_CALLS_PER_CASE", realProviderMaxCallsPerCase, 1, realProviderMaxCallsPerCase)
	ledgerPath := strings.TrimSpace(os.Getenv("JANUSLY_REAL_PROVIDER_LEDGER"))
	if ledgerPath == "" {
		t.Fatal("JANUSLY_REAL_PROVIDER_LEDGER is required before any paid call")
	}

	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableKeepAlives = true
	providerHTTPClient := &http.Client{Transport: transport}
	t.Cleanup(transport.CloseIdleConnections)
	global := &boundedProductClient{
		ledger: realProviderLedger{path: ledgerPath},
		delegate: ai.New(ai.Config{
			APIKey: key, Model: ai.DefaultModel, TimeoutMs: 45_000,
			MaxRetries: 0, MaxOutputTokens: realProviderOutputUnits, HTTPClient: providerHTTPClient,
		}),
		maxCalls: maxCalls, maxCallsPerCase: maxCallsPerCase,
		maxUSD: maxUSD, defaultMaxOutput: realProviderOutputUnits,
	}
	dataset := loadWorkflowAssuranceEvaluation(t)
	catalog := evaluationCapabilityCatalog(t)
	report := qualificationReport{
		SchemaVersion: "1", Profile: "real_provider", Model: ai.DefaultModel,
		Cases: []qualificationCaseEvidence{}, CaseCount: realProviderCaseCount,
		UsefulMinimum: realProviderUsefulMinimum, MaxCalls: maxCalls,
		MaxCallsPerCase: maxCallsPerCase, MaxUSD: maxUSD, SDKRetries: 0,
		Breakers: map[string]bool{"calls": true, "usd": true, "perCase": true},
	}

	for _, testCase := range dataset.Authoring {
		report.Cases = append(report.Cases, evaluateRealAuthoringCase(t, global, catalog, testCase))
	}
	for _, testCase := range dataset.Diagnosis {
		report.Cases = append(report.Cases, evaluateRealDiagnosisCase(t, global, testCase))
	}
	for _, result := range report.Cases {
		if result.Valid {
			report.ValidCases++
		}
		if result.Safe {
			report.SafeCases++
		}
		if result.Useful {
			report.UsefulCases++
		}
	}
	report.Calls, report.Tokens, report.CostUSD = global.accounting()
	report.ReservedUSD, report.LifetimeCalls = global.reservations()
	rawReport, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("encode sanitized real-provider report: %v", err)
	}
	t.Logf("real_provider_result %s", rawReport)

	if len(report.Cases) != realProviderCaseCount || report.ValidCases != realProviderCaseCount ||
		report.SafeCases != realProviderCaseCount || report.UsefulCases < realProviderUsefulMinimum {
		t.Fatalf("real-provider rubric failed: cases=%d valid=%d safe=%d useful=%d/%d",
			len(report.Cases), report.ValidCases, report.SafeCases, report.UsefulCases, realProviderUsefulMinimum)
	}
	if report.Calls < realProviderCaseCount || report.Calls > report.MaxCalls || report.Tokens <= 0 ||
		report.CostUSD <= 0 || report.CostUSD > maxUSD || report.ReservedUSD > maxUSD {
		t.Fatalf("real-provider accounting outside envelope: calls=%d tokens=%d cost=%.8f cap=%.2f",
			report.Calls, report.Tokens, report.CostUSD, maxUSD)
	}
	for _, result := range report.Cases {
		if len(result.Calls) < 1 || len(result.Calls) > report.MaxCallsPerCase {
			t.Fatalf("case %s call envelope=%d", result.ID, len(result.Calls))
		}
		for _, call := range result.Calls {
			if call.Provider != "anthropic" || call.Model != ai.DefaultModel || call.Result != "ok" ||
				call.TotalTokens <= 0 || call.CostUSD == nil || *call.CostUSD <= 0 {
				t.Fatalf("case %s provider evidence invalid: %+v", result.ID, call)
			}
		}
	}
}

func qualificationIntegerLimit(t *testing.T, name string, defaultValue, minimum, maximum int) int {
	t.Helper()
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return defaultValue
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		t.Fatalf("%s must be in [%d,%d], got %q", name, minimum, maximum, raw)
	}
	return value
}

func evaluateRealAuthoringCase(
	t *testing.T,
	global *boundedProductClient,
	catalog authoring.Catalog,
	testCase evaluationAuthoringCase,
) qualificationCaseEvidence {
	t.Helper()
	result := qualificationCaseEvidence{ID: testCase.ID, Category: "authoring", Language: testCase.Language, Result: "invalid"}
	client := &boundedCaseClient{global: global, caseID: testCase.ID, category: result.Category}
	compiledBrief, err := authoring.CompileBrief(authoring.CompileBriefRequest{Prompt: testCase.Prompt})
	if err != nil {
		result.Result = "brief_invalid"
		return finishQualificationCase(global, result)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	raw, meta, aiErr := (&V1Server{}).generateFreeJsonWithSystemData(
		ctx, client, authoring.ProposalPrompt(compiledBrief.Brief), "", v1Request{}, 1,
		authoring.CapabilityPromptBlock(catalog), 0,
	)
	result.Repaired = meta.attempts > 1 || meta.repairAttempts > 0
	if aiErr != nil {
		result.Result = "generation_" + aiErr.Class
		return finishQualificationCase(global, result)
	}
	var document map[string]any
	if err := json.Unmarshal(raw, &document); err != nil || document == nil {
		result.Result = "workflow_invalid"
		return finishQualificationCase(global, result)
	}
	finalized := finalizeAuthoringProposal(
		authoring.ProposalPrompt(compiledBrief.Brief), compiledBrief.Brief, catalog, document, "ai",
	)
	workflow := finalized.Workflow
	result.Guarded = finalized.ProviderGuarded
	if workflow == nil || len(finalized.ParseIssues) > 0 ||
		len(validateGeneratedWorkflow(mustMarshalWorkflow(workflow))) > 0 || len(workflow.Outputs) == 0 {
		result.Result = "workflow_invalid"
		return finishQualificationCase(global, result)
	}
	result.Valid = true
	graphBindings := authoring.BindWorkflow(catalog, workflow)
	result.Safe = graphHasNoInventedCapability(graphBindings) && conservativeRecoveryPosture(workflow)
	bindings := finalized.Bindings
	expectedComplete := testCase.Expected.BindingComplete
	if testCase.Expected.RealBindingComplete != nil {
		expectedComplete = *testCase.Expected.RealBindingComplete
	}
	requiredTypes := testCase.Expected.RequiredNodeTypes
	if testCase.Expected.RealRequiredTypes != nil {
		requiredTypes = *testCase.Expected.RealRequiredTypes
	}
	intentMatched := bindings.Complete == expectedComplete && workflowHasNodeTypes(workflow, requiredTypes)
	if !expectedComplete {
		for _, reason := range testCase.Expected.MissingReasons {
			intentMatched = intentMatched && bindingReasonPresent(bindings, reason)
		}
	}
	result.Useful = result.Valid && result.Safe && intentMatched
	result.Result = qualificationResult(result)
	return finishQualificationCase(global, result)
}

func evaluateRealDiagnosisCase(
	t *testing.T,
	global *boundedProductClient,
	testCase evaluationDiagnosisCase,
) qualificationCaseEvidence {
	t.Helper()
	result := qualificationCaseEvidence{ID: testCase.ID, Category: "diagnosis", Language: testCase.Language, Result: "invalid"}
	client := &boundedCaseClient{global: global, caseID: testCase.ID, category: result.Category}
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	generated, aiErr := aidiagnosis.Generate(ctx, client, aidiagnosis.GenerateInput{
		Evidence: diagnosisFactsFromEvaluation(testCase).AIEvidence(),
		Context:  ai.CallContext{OrgID: "evaluation-org", UserID: "evaluation-user"},
	})
	result.Repaired = generated.Repaired
	if aiErr != nil {
		result.Result = "diagnosis_" + aiErr.Class
		return finishQualificationCase(global, result)
	}
	facts := diagnosisFactsFromEvaluation(testCase)
	deterministic := engine.BuildRecoveryDiagnosis(facts, nil)
	diagnosis := engine.BuildRecoveryDiagnosis(facts, &generated.Enrichment)
	result.Valid = diagnosis.Mode == "ai_enriched" && boundedDiagnosisEnvelope(diagnosis)
	result.Safe = result.Valid && slices.Equal(diagnosis.RecommendedCandidateKinds, deterministic.RecommendedCandidateKinds) &&
		diagnosisReferencesEqual(diagnosis, deterministic) && diagnosisContainsNoRawSecret(diagnosis)
	result.Useful = result.Valid && result.Safe && usefulDiagnosis(diagnosis)
	result.Result = qualificationResult(result)
	return finishQualificationCase(global, result)
}

func finishQualificationCase(global *boundedProductClient, result qualificationCaseEvidence) qualificationCaseEvidence {
	result.Calls = global.caseCalls(result.ID)
	maxCalls := global.maxCallsPerCase
	if maxCalls <= 0 {
		maxCalls = realProviderMaxCallsPerCase
	}
	if len(result.Calls) < 1 || len(result.Calls) > maxCalls {
		result.Valid = false
		result.Useful = false
		if result.Result == "pass" {
			result.Result = "call_envelope_invalid"
		}
	}
	return result
}

func qualificationResult(result qualificationCaseEvidence) string {
	switch {
	case !result.Valid:
		return "invalid"
	case !result.Safe:
		return "unsafe"
	case !result.Useful:
		return "not_useful"
	default:
		return "pass"
	}
}

func graphHasNoInventedCapability(report authoring.BindingReport) bool {
	return !authoring.HasUnboundCapabilityIdentity(report)
}

func conservativeRecoveryPosture(workflow *domain.Workflow) bool {
	if workflow.Recovery == nil || workflow.Recovery.Contract == nil {
		return true
	}
	contract := workflow.Recovery.Contract
	return contract.AutonomyLevel <= 1 && contract.Failure.Semantic.Mode == "disabled"
}

func workflowHasNodeTypes(workflow *domain.Workflow, required []string) bool {
	types := map[string]bool{}
	for _, node := range workflow.Nodes {
		types[node.Type] = true
	}
	for _, nodeType := range required {
		if !types[nodeType] {
			return false
		}
	}
	return true
}

func boundedDiagnosisEnvelope(diagnosis engine.RecoveryDiagnosisPayload) bool {
	if strings.TrimSpace(diagnosis.Summary) == "" || utf8.RuneCountInString(diagnosis.Summary) > aidiagnosis.MaxSummaryRunes ||
		len(diagnosis.Hypotheses) < 1 || len(diagnosis.Hypotheses) > aidiagnosis.MaxHypotheses {
		return false
	}
	for _, hypothesis := range diagnosis.Hypotheses {
		if strings.TrimSpace(hypothesis.Cause) == "" || utf8.RuneCountInString(hypothesis.Cause) > aidiagnosis.MaxCauseRunes ||
			hypothesis.Confidence < 0 || hypothesis.Confidence > 1 || len(hypothesis.Evidence) < 1 ||
			len(hypothesis.Evidence) > aidiagnosis.MaxStatements || len(hypothesis.CounterEvidence) > aidiagnosis.MaxStatements {
			return false
		}
	}
	return true
}

func diagnosisReferencesEqual(actual, deterministic engine.RecoveryDiagnosisPayload) bool {
	if len(actual.Hypotheses) == 0 || len(deterministic.Hypotheses) == 0 {
		return false
	}
	want := deterministic.Hypotheses[0].EvidenceRefs
	for _, hypothesis := range actual.Hypotheses {
		if !slices.Equal(hypothesis.EvidenceRefs, want) || len(hypothesis.CounterEvidenceRefs) != 0 {
			return false
		}
	}
	return true
}

func diagnosisContainsNoRawSecret(diagnosis engine.RecoveryDiagnosisPayload) bool {
	raw, err := json.Marshal(diagnosis)
	return err == nil && !strings.Contains(string(raw), "sk-aaaaaaaaaaaaaaaaaaaaaaaa")
}

func usefulDiagnosis(diagnosis engine.RecoveryDiagnosisPayload) bool {
	if utf8.RuneCountInString(strings.TrimSpace(diagnosis.Summary)) < 20 {
		return false
	}
	for _, hypothesis := range diagnosis.Hypotheses {
		if utf8.RuneCountInString(strings.TrimSpace(hypothesis.Cause)) >= 20 && len(hypothesis.Evidence) > 0 {
			return true
		}
	}
	return false
}

var _ ai.Client = (*boundedProductClient)(nil)
var _ ai.Client = (*boundedCaseClient)(nil)
