package domain

import (
	"encoding/json"
	"fmt"
	"testing"
)

// benchmarkWorkflowDoc builds a chain of transform nodes the size of a
// large production snapshot; Parse runs on it for every claim.
func benchmarkWorkflowDoc(nodes int) []byte {
	doc := map[string]any{"dslVersion": "1.0", "id": "bench", "name": "bench", "metadata": map[string]any{"tags": []string{"a"}}}
	nodeList := make([]map[string]any, 0, nodes)
	edgeList := make([]map[string]any, 0, nodes)
	for i := range nodes {
		nodeList = append(nodeList, map[string]any{
			"id": fmt.Sprintf("n%d", i), "type": "transform", "label": fmt.Sprintf("Step %d", i),
			"config": map[string]any{"mapping": map[string]any{
				"total": fmt.Sprintf("{{context.n%d.output.total}}", max(i-1, 0)),
				"via":   "{{context.input.source}}",
				"note":  "a literal value long enough to look like real config text",
			}},
		})
		if i > 0 {
			edgeList = append(edgeList, map[string]any{"from": fmt.Sprintf("n%d", i-1), "to": fmt.Sprintf("n%d", i)})
		}
	}
	doc["nodes"], doc["edges"] = nodeList, edgeList
	raw, _ := json.Marshal(doc)
	return raw
}

func BenchmarkParse(b *testing.B) {
	raw := benchmarkWorkflowDoc(200)
	b.ReportAllocs()
	b.SetBytes(int64(len(raw)))
	for b.Loop() {
		if wf, issues := Parse(raw); wf == nil {
			b.Fatal(issues)
		}
	}
}
