package httpapi

import (
	"encoding/json"
	"testing"
)

// T-533: the strict CloudEvents parser eats EXTERNAL input — it must
// never panic (broken UTF-8 included), only ever accept the three known
// types, and stay strict: injecting one unknown envelope field into an
// accepted event must flip it to rejected.
func FuzzParseExternalRuntimeEvent(f *testing.F) {
	f.Add([]byte(`{"specversion":"1.0","id":"e1","source":"//ext","type":"io.janusly.external.run.observed","data":{"sequence":1,"externalWorkflowId":"wf","externalRunId":"r1","status":"succeeded"}}`))
	f.Add([]byte(`{"specversion":"1.0","id":"e2","source":"//ext","type":"io.janusly.external.workflow.observed","data":{"sequence":2,"externalWorkflowId":"wf","name":"n"}}`))
	f.Add([]byte(`{"type":"io.janusly.external.step.observed"}`))
	f.Add([]byte(`{"hax":true}`))
	f.Add([]byte{0xff, 0xfe, '{', 'b', 'r', 'o', 'k', 'e', 'n'})
	f.Add([]byte(`[]`))
	f.Add([]byte(`null`))
	f.Fuzz(func(t *testing.T, raw []byte) {
		event := parseExternalRuntimeEvent(raw) // must never panic
		if event == nil {
			return
		}
		if _, known := allowedExternalDataFields[event.Type]; !known {
			t.Fatalf("accepted an unknown type %q", event.Type)
		}
		// Strictness: one unknown envelope field must reject.
		var envelope map[string]json.RawMessage
		if json.Unmarshal(raw, &envelope) != nil {
			t.Fatalf("accepted event whose raw does not re-parse")
		}
		envelope["janusly_fuzz_unknown"] = json.RawMessage(`true`)
		mutated, _ := json.Marshal(envelope)
		if parseExternalRuntimeEvent(mutated) != nil {
			t.Fatalf("strictness hole: unknown envelope field accepted")
		}
	})
}
