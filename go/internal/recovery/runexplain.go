// Run Explain Report — the pure builder ported from the reference's
// run-explain-report.ts: a shareable Markdown + JSON artefact summarising
// one run for a stakeholder (summary, root cause via the shared
// signature taxonomy, failed node, capped timeline, suggested fix from
// the latest patch audit, next action by suggested owner). Pure — no DB,
// no I/O; the route resolves snapshots. Hard safety property: no raw
// secret value ever appears — rows are key-redacted at write time and
// every rendered free-form string re-passes ScrubSecretShapes here.
package recovery

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/johnny4young/janusly/go/internal/signature"
)

// RunExplainTimelineCap keeps the artefact readable; over-cap keeps the
// LAST entries (failure context is at the tail).
const RunExplainTimelineCap = 50

// RunExplainRun is the runs-row snapshot the builder needs.
type RunExplainRun struct {
	ID                      string
	Status                  string
	WorkflowVersionID       string
	ParentRunID             string
	ReplayMode              string
	ValidationEvidenceLevel string
	CreatedAt               *time.Time
}

// RunExplainNode is one run_nodes-row snapshot.
type RunExplainNode struct {
	NodeID     string
	Status     string
	Attempts   int
	StartedAt  *time.Time
	FinishedAt *time.Time
	NodeType   string
	ErrorJSON  []byte
}

// RunExplainEvent is one run_events-row snapshot.
type RunExplainEvent struct {
	NodeID    string
	Type      string
	CreatedAt *time.Time
}

// RunExplainAudit is the latest ai.workflow.patch_suggested audit row.
type RunExplainAudit struct {
	CreatedAt *time.Time
	Metadata  []byte
}

func isoOrNil(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func safeText(value string, maxLen int) string {
	scrubbed := signature.ScrubSecretShapes(value)
	if len(scrubbed) > maxLen {
		return scrubbed[:maxLen]
	}
	return scrubbed
}

// runExplainNextAction maps the suggested owner onto the operator's move.
var runExplainNextAction = map[string]string{
	"ops":             "Set the missing secret or credential in the environment, then replay the run from the Recovery Queue.",
	"workflow_author": "Review the failing node's config and the suggested patch (if any), apply a fix in AI Studio, then replay.",
	"platform":        "File a platform incident — the failure is in shared infrastructure (LLM provider, ingress, runtime).",
}

// BuildRunExplainReport builds the JSON envelope + Markdown rendering.
func BuildRunExplainReport(run RunExplainRun, nodes []RunExplainNode, events []RunExplainEvent, audit *RunExplainAudit, now time.Time) (map[string]any, string) {
	isFailure := run.Status == "failed"

	// Latest failed node by finish (start as tiebreak) — parallel branches
	// can fail; the latest wins.
	var failed *RunExplainNode
	failedStamp := ""
	for i := range nodes {
		if nodes[i].Status != "failed" {
			continue
		}
		stamp := ""
		if nodes[i].FinishedAt != nil {
			stamp = nodes[i].FinishedAt.UTC().Format(time.RFC3339Nano)
		} else if nodes[i].StartedAt != nil {
			stamp = nodes[i].StartedAt.UTC().Format(time.RFC3339Nano)
		}
		if failed == nil || stamp > failedStamp {
			failed = &nodes[i]
			failedStamp = stamp
		}
	}

	var rootCause map[string]any
	if failed != nil && len(failed.ErrorJSON) > 0 {
		result := signature.NormalizeJSON(failed.ErrorJSON, signature.Context{
			NodeID: failed.NodeID, NodeType: failed.NodeType,
		})
		rootCause = map[string]any{
			"signature":      safeText(result.Signature, 240),
			"category":       result.Category,
			"suggestedOwner": result.SuggestedOwner,
		}
	}

	var failedBlock map[string]any
	if failed != nil {
		message := "(no error message recorded)"
		var payload map[string]any
		if json.Unmarshal(failed.ErrorJSON, &payload) == nil {
			for _, key := range []string{"message", "error", "code"} {
				if s, ok := payload[key].(string); ok && s != "" {
					message = s
					break
				}
			}
		}
		attempts := failed.Attempts
		if attempts < 1 {
			attempts = 1
		}
		failedBlock = map[string]any{
			"nodeId": safeText(failed.NodeID, 120), "status": failed.Status, "attempts": attempts,
			"startedAt": isoOrNil(failed.StartedAt), "finishedAt": isoOrNil(failed.FinishedAt),
			"errorSummary": safeText(message, 240),
		}
	}

	// Timeline: ascending, keep the tail over the cap.
	sorted := make([]RunExplainEvent, len(events))
	copy(sorted, events)
	for i := 1; i < len(sorted); i++ {
		for j := i; j > 0; j-- {
			left, right := "", ""
			if sorted[j-1].CreatedAt != nil {
				left = sorted[j-1].CreatedAt.UTC().Format(time.RFC3339Nano)
			}
			if sorted[j].CreatedAt != nil {
				right = sorted[j].CreatedAt.UTC().Format(time.RFC3339Nano)
			}
			if right < left {
				sorted[j-1], sorted[j] = sorted[j], sorted[j-1]
			} else {
				break
			}
		}
	}
	truncated := len(sorted) > RunExplainTimelineCap
	if truncated {
		sorted = sorted[len(sorted)-RunExplainTimelineCap:]
	}
	timeline := make([]map[string]any, 0, len(sorted))
	for _, event := range sorted {
		var nodeID any
		if event.NodeID != "" {
			nodeID = safeText(event.NodeID, 120)
		}
		timeline = append(timeline, map[string]any{
			"at": isoOrNil(event.CreatedAt), "nodeId": nodeID, "type": safeText(event.Type, 120),
		})
	}

	var suggestedFix map[string]any
	if audit != nil && len(audit.Metadata) > 0 {
		var metadata map[string]any
		_ = json.Unmarshal(audit.Metadata, &metadata)
		mode := "fallback"
		if m, ok := metadata["mode"].(string); ok && (m == "ai" || m == "fallback") {
			mode = m
		}
		patchStyle := "unknown"
		if p, ok := metadata["patchStyle"].(string); ok && (p == "structural" || p == "config_only") {
			patchStyle = p
		}
		label := "(unknown)"
		if l, ok := metadata["topApproachLabel"].(string); ok && l != "" {
			label = l
		}
		envelope := "(unknown)"
		if e, ok := metadata["envelopeKind"].(string); ok && e != "" {
			envelope = e
		}
		count := 0
		if c, ok := metadata["suggestionsCount"].(float64); ok && c > 0 {
			count = int(c)
		}
		suggestedFix = map[string]any{
			"mode": mode, "topApproachLabel": safeText(label, 120),
			"envelopeKind": safeText(envelope, 120), "patchStyle": patchStyle,
			"suggestionsCount": count, "suggestedAt": isoOrNil(audit.CreatedAt),
		}
	}

	nextAction := "Run succeeded — no operator action required."
	if isFailure {
		nextAction = "Inspect the run timeline and node state for the failure cause, then iterate."
		if rootCause != nil {
			if action, ok := runExplainNextAction[rootCause["suggestedOwner"].(string)]; ok {
				nextAction = action
			}
		}
	}

	report := map[string]any{
		"generatedAt": now.UTC().Format(time.RFC3339Nano),
		"summary": map[string]any{
			"runId": run.ID, "status": run.Status,
			"workflowVersionId":       nilIfEmpty(run.WorkflowVersionID),
			"parentRunId":             nilIfEmpty(run.ParentRunID),
			"replayMode":              nilIfEmpty(run.ReplayMode),
			"validationEvidenceLevel": nilIfEmpty(run.ValidationEvidenceLevel),
			"createdAt":               isoOrNil(run.CreatedAt),
			"isFailure":               isFailure,
		},
		"rootCause": anyOrNil(rootCause), "failedNode": anyOrNil(failedBlock),
		"timeline": timeline, "timelineTruncated": truncated,
		"suggestedFix": anyOrNil(suggestedFix), "nextAction": nextAction,
	}
	return report, renderRunExplainMarkdown(report)
}

func nilIfEmpty(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func anyOrNil(value map[string]any) any {
	if value == nil {
		return nil
	}
	return value
}

func markdownEscape(value string) string {
	return strings.ReplaceAll(value, "`", "\\`")
}

func renderRunExplainMarkdown(report map[string]any) string {
	summary := report["summary"].(map[string]any)
	var lines []string
	push := func(line string) { lines = append(lines, line) }
	push(fmt.Sprintf("# Run Explain Report — %s", markdownEscape(summary["runId"].(string))))
	push("")
	push(fmt.Sprintf("> Generated %s", report["generatedAt"].(string)))
	push("")
	push("## Summary")
	push(fmt.Sprintf("- **Run id:** `%s`", markdownEscape(summary["runId"].(string))))
	push(fmt.Sprintf("- **Status:** %s", summary["status"]))
	if v, ok := summary["workflowVersionId"].(string); ok {
		push(fmt.Sprintf("- **Workflow version:** `%s`", markdownEscape(v)))
	}
	if v, ok := summary["createdAt"].(string); ok {
		push(fmt.Sprintf("- **Created at:** %s", v))
	}
	if v, ok := summary["parentRunId"].(string); ok {
		push(fmt.Sprintf("- **Parent run:** `%s`", markdownEscape(v)))
	}
	if v, ok := summary["replayMode"].(string); ok {
		push(fmt.Sprintf("- **Replay mode:** %s (sandbox — not a production run)", v))
	}
	if v, ok := summary["validationEvidenceLevel"].(string); ok {
		push(fmt.Sprintf("- **Validation evidence:** %s", v))
	}
	push("")
	if rootCause, ok := report["rootCause"].(map[string]any); ok {
		push("## Root cause")
		push(fmt.Sprintf("- **Signature:** %s", markdownEscape(rootCause["signature"].(string))))
		push(fmt.Sprintf("- **Category:** %s", rootCause["category"]))
		push(fmt.Sprintf("- **Suggested owner:** %s", rootCause["suggestedOwner"]))
		push("")
	}
	if failed, ok := report["failedNode"].(map[string]any); ok {
		push("## Failed node")
		push(fmt.Sprintf("- **Node id:** `%s`", markdownEscape(failed["nodeId"].(string))))
		push(fmt.Sprintf("- **Status:** %s", failed["status"]))
		push(fmt.Sprintf("- **Attempts:** %d", failed["attempts"]))
		if v, ok := failed["startedAt"].(string); ok {
			push(fmt.Sprintf("- **Started:** %s", v))
		}
		if v, ok := failed["finishedAt"].(string); ok {
			push(fmt.Sprintf("- **Finished:** %s", v))
		}
		push("")
		push("**Error summary** (redacted):")
		push("")
		push("```")
		push(markdownEscape(failed["errorSummary"].(string)))
		push("```")
		push("")
	}
	push("## Timeline")
	timeline := report["timeline"].([]map[string]any)
	if len(timeline) == 0 {
		push("_No events recorded yet._")
	} else {
		if report["timelineTruncated"].(bool) {
			push(fmt.Sprintf("_Showing the last %d events. Older events were trimmed for readability._", RunExplainTimelineCap))
			push("")
		}
		for _, entry := range timeline {
			stamp := "(unknown time)"
			if v, ok := entry["at"].(string); ok {
				stamp = v
			}
			node := ""
			if v, ok := entry["nodeId"].(string); ok {
				node = fmt.Sprintf(" node=`%s`", markdownEscape(v))
			}
			push(fmt.Sprintf("- %s — **%s**%s", stamp, markdownEscape(entry["type"].(string)), node))
		}
	}
	push("")
	push("## Suggested fix")
	if fix, ok := report["suggestedFix"].(map[string]any); ok {
		push(fmt.Sprintf("- **Mode:** %s", fix["mode"]))
		push(fmt.Sprintf("- **Approach:** %s", fix["topApproachLabel"]))
		push(fmt.Sprintf("- **Envelope:** %s", fix["envelopeKind"]))
		push(fmt.Sprintf("- **Patch style:** %s", fix["patchStyle"]))
		push(fmt.Sprintf("- **Alternatives proposed:** %d", fix["suggestionsCount"]))
		if v, ok := fix["suggestedAt"].(string); ok {
			push(fmt.Sprintf("- **Suggested at:** %s", v))
		}
	} else {
		push("_No prior recovery suggestion exists for this run. Open the Recovery Queue to request one._")
	}
	push("")
	push("## Next action")
	push(report["nextAction"].(string))
	push("")
	return strings.Join(lines, "\n")
}
