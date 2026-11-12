package hookwire

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

var testNow = time.Date(2026, 11, 12, 15, 0, 0, 0, time.UTC)

func envelope(eventType string, data map[string]any) map[string]any {
	return map[string]any{
		"specversion": "1.0", "id": EventID("s1", eventType), "source": Source(RuntimeClaudeCode),
		"type": eventType, "time": testNow.Format(time.RFC3339Nano), "datacontenttype": "application/json",
		"data": data,
	}
}

func encode(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestParseAcceptsEveryType(t *testing.T) {
	duration := 812
	cases := map[string]map[string]any{
		TypeSessionStarted:  {"sessionId": "s1", "project": "billing", "runtimeVersion": "2.1.0", "model": "opus"},
		TypePromptSubmitted: {"sessionId": "s1"},
		TypeToolRequested:   {"sessionId": "s1", "toolUseId": "t1", "tool": "mcp__notion__search", "toolKind": "mcp", "mcpServer": "notion"},
		TypeToolCompleted: {"sessionId": "s1", "agentId": "a1", "toolUseId": "t1", "tool": "Bash", "toolKind": "builtin",
			"status": "ok", "durationMs": duration, "januslyRefs": map[string]any{"runId": "run_1"}},
		TypeSubagentStarted: {"sessionId": "s1", "agentId": "a1", "parentAgentId": "s1", "agentType": "Explore"},
		TypeSubagentStopped: {"sessionId": "s1", "agentId": "a1", "status": "ok"},
		TypeTurnStopped:     {"sessionId": "s1"},
		TypeSessionEnded:    {"sessionId": "s1", "status": "interrupted"},
	}
	for eventType, data := range cases {
		event, err := Parse(encode(t, envelope(eventType, data)), testNow)
		if err != nil {
			t.Fatalf("%s: %v", eventType, err)
		}
		if event.Runtime() != RuntimeClaudeCode || event.Data.SessionID != "s1" {
			t.Fatalf("%s parsed as %+v", eventType, event)
		}
	}
}

func TestParseIsStrict(t *testing.T) {
	valid := func() map[string]any {
		return envelope(TypeToolRequested, map[string]any{"sessionId": "s1", "tool": "Read", "toolKind": "builtin"})
	}
	mutations := map[string]func(map[string]any){
		"unknown envelope field": func(e map[string]any) { e["subject"] = "x" },
		"unknown data field":     func(e map[string]any) { e["data"].(map[string]any)["cwd"] = "/Users/me/repo" },
		"field of another type":  func(e map[string]any) { e["data"].(map[string]any)["status"] = "ok" },
		"content without capture": func(e map[string]any) {
			e["data"].(map[string]any)["content"] = map[string]any{"input": "secret"}
		},
		"transcript path":       func(e map[string]any) { e["data"].(map[string]any)["transcriptPath"] = "/tmp/x.jsonl" },
		"unknown type":          func(e map[string]any) { e["type"] = "io.janusly.agent.command.run" },
		"unknown runtime":       func(e map[string]any) { e["source"] = "janusly-hook/1/cursor" },
		"foreign source":        func(e map[string]any) { e["source"] = "evil/claude-code" },
		"short id":              func(e map[string]any) { e["id"] = "abc" },
		"spec version":          func(e map[string]any) { e["specversion"] = "0.3" },
		"future time":           func(e map[string]any) { e["time"] = testNow.Add(10 * time.Minute).Format(time.RFC3339) },
		"time past retention":   func(e map[string]any) { e["time"] = testNow.Add(-15 * 24 * time.Hour).Format(time.RFC3339) },
		"missing session":       func(e map[string]any) { delete(e["data"].(map[string]any), "sessionId") },
		"missing tool":          func(e map[string]any) { delete(e["data"].(map[string]any), "tool") },
		"bad tool kind":         func(e map[string]any) { e["data"].(map[string]any)["toolKind"] = "shell" },
		"server on builtin":     func(e map[string]any) { e["data"].(map[string]any)["mcpServer"] = "notion" },
		"control character":     func(e map[string]any) { e["data"].(map[string]any)["sessionId"] = "s\n1" },
		"padded id":             func(e map[string]any) { e["data"].(map[string]any)["sessionId"] = " s1" },
		"long id":               func(e map[string]any) { e["data"].(map[string]any)["sessionId"] = strings.Repeat("s", 201) },
		"data is not an object": func(e map[string]any) { e["data"] = []any{} },
		"content type":          func(e map[string]any) { e["datacontenttype"] = "text/plain" },
	}
	for name, mutate := range mutations {
		event := valid()
		mutate(event)
		if _, err := Parse(encode(t, event), testNow); !errors.Is(err, ErrInvalidEvent) {
			t.Fatalf("%s: accepted (%v)", name, err)
		}
	}
	for _, raw := range []string{"", "null", "[]", "{", `{"specversion":"1.0"}`} {
		if _, err := Parse([]byte(raw), testNow); err == nil {
			t.Fatalf("accepted %q", raw)
		}
	}
}

func TestParseRefusesPathsStatusesAndRefs(t *testing.T) {
	bad := []struct {
		name      string
		eventType string
		data      map[string]any
	}{
		{"full project path", TypeSessionStarted, map[string]any{"sessionId": "s1", "project": "/Users/me/repo"}},
		{"windows project path", TypeSessionStarted, map[string]any{"sessionId": "s1", "project": `C:\work\repo`}},
		{"tool status", TypeToolCompleted, map[string]any{"sessionId": "s1", "tool": "Read", "toolKind": "builtin", "status": "succeeded"}},
		{"missing end status", TypeSessionEnded, map[string]any{"sessionId": "s1"}},
		{"subagent without id", TypeSubagentStarted, map[string]any{"sessionId": "s1", "agentType": "Explore"}},
		{"negative duration", TypeToolCompleted, map[string]any{"sessionId": "s1", "tool": "Read", "toolKind": "builtin", "status": "ok", "durationMs": -1}},
		{"ref with spaces", TypeToolCompleted, map[string]any{"sessionId": "s1", "tool": "Read", "toolKind": "builtin", "status": "ok",
			"januslyRefs": map[string]any{"runId": "run 1"}}},
		{"bidi override", TypeSessionStarted, map[string]any{"sessionId": "s1", "project": "evil\u202eexe.txt"}},
		{"zero width", TypeToolRequested, map[string]any{"sessionId": "s1", "tool": "Re\u200bad", "toolKind": "builtin"}},
		{"dot project", TypeSessionStarted, map[string]any{"sessionId": "s1", "project": ".."}},
		{"unknown ref", TypeToolCompleted, map[string]any{"sessionId": "s1", "tool": "Read", "toolKind": "builtin", "status": "ok",
			"januslyRefs": map[string]any{"versionId": "v1"}}},
	}
	for _, tc := range bad {
		if _, err := Parse(encode(t, envelope(tc.eventType, tc.data)), testNow); !errors.Is(err, ErrInvalidEvent) {
			t.Fatalf("%s: accepted (%v)", tc.name, err)
		}
	}
}

func TestParseRefusesSecretShapedIdentities(t *testing.T) {
	token := "jly_agent_" + strings.Repeat("A", 43)
	for _, data := range []map[string]any{
		{"sessionId": "ghp_" + strings.Repeat("a", 36)},
		{"sessionId": "s1", "agentId": "sk-ant-api03-" + strings.Repeat("b", 40)},
		{"sessionId": "s1", "project": "AKIA" + strings.Repeat("Q", 16)},
		{"sessionId": "s1", "model": "Bearer " + token},
	} {
		if _, err := Parse(encode(t, envelope(TypeSessionStarted, data)), testNow); !errors.Is(err, ErrSensitiveIdentity) {
			t.Fatalf("accepted secret-shaped identity %v: %v", data, err)
		}
	}
	for _, ref := range []string{"ghp_" + strings.Repeat("a", 36), "sk-ant-api03-" + strings.Repeat("b", 40), token} {
		data := map[string]any{"sessionId": "s1", "tool": "Read", "toolKind": "builtin", "status": "ok",
			"januslyRefs": map[string]any{"runId": ref}}
		if _, err := Parse(encode(t, envelope(TypeToolCompleted, data)), testNow); !errors.Is(err, ErrSensitiveIdentity) {
			t.Fatalf("accepted secret-shaped ref %q: %v", ref, err)
		}
	}
	for _, data := range []map[string]any{} {
		if _, err := Parse(encode(t, envelope(TypeSessionStarted, data)), testNow); !errors.Is(err, ErrSensitiveIdentity) {
			t.Fatalf("accepted secret-shaped identity %v: %v", data, err)
		}
	}
}

func TestSigningKeyMatchesOnBothSides(t *testing.T) {
	token := "jly_agent_" + strings.Repeat("x", 43)
	digest := sha256.Sum256([]byte(token))
	key := SigningKeyFromToken(token)
	if key == "" || key != SigningKeyFromDigest(digest[:]) {
		t.Fatal("bridge and server derive different keys")
	}
	if key == SigningKeyFromToken(token+"y") || strings.Contains(key, token) {
		t.Fatal("key does not depend on the token")
	}
	body := []byte(`{"a":1}`)
	header := Sign(key, testNow.Unix(), body)
	if !Verify(header, key, body, testNow.Unix()) {
		t.Fatal("own signature rejected")
	}
	for name, ok := range map[string]bool{
		"tampered body":  Verify(header, key, []byte(`{"a":2}`), testNow.Unix()),
		"other key":      Verify(header, SigningKeyFromToken("other"), body, testNow.Unix()),
		"outside window": Verify(header, key, body, testNow.Add(301*time.Second).Unix()),
		"empty header":   Verify("", key, body, testNow.Unix()),
	} {
		if ok {
			t.Fatalf("%s verified", name)
		}
	}
}

func FuzzParse(f *testing.F) {
	seed, _ := json.Marshal(envelope(TypeToolCompleted, map[string]any{"sessionId": "s1", "tool": "Read", "toolKind": "builtin", "status": "ok"}))
	f.Add(seed)
	f.Add([]byte(`{"type":"io.janusly.agent.turn.stopped"}`))
	f.Add([]byte{0xff, 0xfe, '{'})
	f.Fuzz(func(t *testing.T, raw []byte) {
		event, err := Parse(raw, testNow)
		if err != nil {
			return
		}
		if _, known := dataFields[event.Type]; !known {
			t.Fatalf("accepted unknown type %q", event.Type)
		}
		var fields map[string]json.RawMessage
		if json.Unmarshal(raw, &fields) != nil {
			t.Fatal("accepted an event that does not re-parse")
		}
		fields["janusly_fuzz_unknown"] = json.RawMessage(`true`)
		mutated, _ := json.Marshal(fields)
		if _, err := Parse(mutated, testNow); err == nil {
			t.Fatal("strictness hole: unknown envelope field accepted")
		}
	})
}
