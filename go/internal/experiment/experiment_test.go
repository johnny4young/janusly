package experiment

import (
	"context"
	"testing"

	"github.com/johnny4young/janusly/go/internal/ai"
)

func TestScorers(t *testing.T) {
	ctx := context.Background()
	// string_equality: forgiving whitespace/case.
	if score := ScoreOutput(ctx, "string_equality", "  Retry   The Node ", "retry the node", nil, ai.CallContext{}); score.Score != 1 {
		t.Fatalf("forgiving equality: %+v", score)
	}
	if score := ScoreOutput(ctx, "string_equality", "otra cosa", "retry the node", nil, ai.CallContext{}); score.Score != 0 {
		t.Fatalf("mismatch: %+v", score)
	}
	// json_schema: expected interpreted as the declared-input subset.
	schema := `{"type":"object","required":["action"],"properties":{"action":{"type":"string"}}}`
	if score := ScoreOutput(ctx, "json_schema", `{"action":"retry"}`, schema, nil, ai.CallContext{}); score.Score != 1 {
		t.Fatalf("valid json: %+v", score)
	}
	if score := ScoreOutput(ctx, "json_schema", `{"other":1}`, schema, nil, ai.CallContext{}); score.Score != 0 {
		t.Fatalf("invalid json: %+v", score)
	}
	// A non-schema expected value falls back to string equality.
	if score := ScoreOutput(ctx, "json_schema", "plain", "plain", nil, ai.CallContext{}); score.Score != 1 {
		t.Fatalf("schema fallback: %+v", score)
	}
	// llm_judge without a client degrades to token overlap, flagged.
	judge := ScoreOutput(ctx, "llm_judge", "retry the node now", "retry the node", nil, ai.CallContext{})
	if judge.JudgedByLlm || judge.FallbackReason != "llm_not_configured" || judge.Score <= 0.5 {
		t.Fatalf("judge fallback: %+v", judge)
	}
}

// A nil client completes the run deterministically: both sides error with
// llm_not_configured, score 0, and the recommendation ladder answers.
func TestRunWithoutClientNeverThrows(t *testing.T) {
	calls := []Call{}
	summary := Run(context.Background(), nil, "string_equality",
		Arm{ModelHint: "model-a"}, Arm{ModelHint: "model-b"},
		[]Example{{Input: "in", Expected: "out"}, {Input: "in2", Expected: "out2"}},
		ai.CallContext{OrgID: "org"}, func(call Call) { calls = append(calls, call) })
	if summary.ExampleCount != 2 || summary.Control.ErrorCount != 2 || summary.Candidate.ErrorCount != 2 {
		t.Fatalf("no-client run: %+v", summary)
	}
	if summary.Recommendation != "keep_control" {
		t.Fatalf("tie must keep control: %+v", summary)
	}
	if len(calls) != 4 || calls[0].AiError != "llm_not_configured" {
		t.Fatalf("telemetry hook: %d %+v", len(calls), calls)
	}
	// Empty dataset → inconclusive.
	if empty := Run(context.Background(), nil, "string_equality", Arm{}, Arm{}, nil,
		ai.CallContext{}, nil); empty.Recommendation != "inconclusive" {
		t.Fatalf("empty dataset: %+v", empty)
	}
}
