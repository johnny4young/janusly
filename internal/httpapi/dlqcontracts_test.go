package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/contract"
	"github.com/johnny4young/janusly/internal/recovery"
	"github.com/johnny4young/janusly/internal/store"
)

func dlqDetailFixture(t *testing.T) map[string]any {
	t.Helper()
	view := newDeadLetterDetailView(store.GetDeadLetterRow{ID: "letter", OrgID: "org", RunID: "run", NodeID: "node", Status: "open", Attempt: 1})
	raw, err := json.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatal(err)
	}
	return data
}

func TestDLQDetailManifestMatchesWire(t *testing.T) {
	const path = "/v1/dlq/entries/{deadLetterId}"
	data := dlqDetailFixture(t)
	requireManifestData(t, path, data)
	view := recovery.BuildRecoveryDrillOutcome(recovery.DrillOutcomeFacts{LatestDeadLetterID: "letter", LatestStatus: "open", AttemptCount: 1}, time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC))
	raw, err := json.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	var outcome any
	if err := json.Unmarshal(raw, &outcome); err != nil {
		t.Fatal(err)
	}
	data["drillOutcome"] = outcome
	data["drill"] = map[string]any{"kind": "solution_pack_drill", "packId": "pack", "fixtureId": "fixture", "recoveryPath": "runtime_failure"}
	requireManifestData(t, path, data)
}

func TestDLQDetailManifestRejectsIncompleteEvidence(t *testing.T) {
	for name, mutate := range map[string]func(map[string]any){
		"summary":          func(v map[string]any) { delete(v, "workflowJson") },
		"missing null":     func(v map[string]any) { delete(v, "replayedAt") },
		"invalid status":   func(v map[string]any) { v["status"] = "done" },
		"negative attempt": func(v map[string]any) { v["attempt"] = -1 },
		"invalid drill":    func(v map[string]any) { v["drill"] = map[string]any{} },
		"invalid outcome":  func(v map[string]any) { v["drillOutcome"] = map[string]any{"status": "recovered"} },
	} {
		t.Run(name, func(t *testing.T) {
			data := dlqDetailFixture(t)
			mutate(data)
			if err := resolvedResponseSchema(t, "/v1/dlq/entries/{deadLetterId}").Validate(data); err == nil {
				t.Fatal("invalid detail accepted")
			}
		})
	}
}

func TestDLQSummaryManifestMatchesTypedWire(t *testing.T) {
	view := newDeadLetterSummaryView(store.ListDeadLetterSummariesRow{
		ID: "letter", OrgID: "org", RunID: "run", NodeID: "node", Status: "open", Attempt: 1,
	})
	raw, err := json.Marshal([]DeadLetterSummaryView{view})
	if err != nil {
		t.Fatal(err)
	}
	var data []any
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatal(err)
	}
	requireManifestData(t, "/v1/dlq", data)
	requireManifestData(t, "/v1/dlq", []any{})
	if err := resolvedResponseSchema(t, "/v1/dlq").Validate(dlqDetailFixture(t)); err == nil {
		t.Fatal("list schema accepted a detail object")
	}
	rows := make([]any, 201)
	for i := range rows {
		rows[i] = data[0]
	}
	if err := resolvedResponseSchema(t, "/v1/dlq").Validate(rows); err == nil {
		t.Fatal("list schema accepted an oversized page")
	}
}

func TestDLQNullableAggregateTextEncoding(t *testing.T) {
	empty := ""
	value := "node"
	for _, tc := range []struct {
		name  string
		value any
		want  string
	}{
		{"absent", nil, "null"},
		{"coalesced absent", "", "null"},
		{"value", "node", `"node"`},
		{"empty pointer", &empty, `""`},
		{"value pointer", &value, `"node"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := json.Marshal(textOrNullString(tc.value))
			if err != nil {
				t.Fatal(err)
			}
			if string(raw) != tc.want {
				t.Fatalf("wire changed: %s != %s", raw, tc.want)
			}
		})
	}
}

func TestDLQResolveManifestRequiresAffirmativeReceipt(t *testing.T) {
	schema := resolvedManifestSchema(t, "POST", "/v1/dlq/resolve")
	if err := schema.Validate(map[string]any{"ok": true}); err != nil {
		t.Fatal(err)
	}
	for _, value := range []any{nil, map[string]any{}, map[string]any{"ok": false}, map[string]any{"ok": "true"}} {
		if err := schema.Validate(value); err == nil {
			t.Fatalf("invalid receipt accepted: %v", value)
		}
	}
}

func TestCloseReasonBoundMatchesContract(t *testing.T) {
	for _, route := range contract.Routes {
		if route.Method != "POST" || route.Path != "/v1/dlq/resolve" {
			continue
		}
		reason := route.Request["properties"].(map[string]any)["reason"].(map[string]any)
		if reason["maxLength"] != closeReasonMaxRunes {
			t.Fatalf("contract maxLength %v, handler %d", reason["maxLength"], closeReasonMaxRunes)
		}
		return
	}
	t.Fatal("route not in the manifest")
}

func TestReadCloseReason(t *testing.T) {
	full := strings.Repeat("é", closeReasonMaxRunes)
	valid := []struct {
		name string
		raw  any
		want string
	}{
		{"absent", nil, ""},
		{"trimmed", "  refunded by hand\n", "refunded by hand"},
		{"multiline", "refunded\n\tby hand", "refunded\n\tby hand"},
		{"limit counts characters, not bytes", full, full},
	}
	for _, tc := range valid {
		t.Run(tc.name, func(t *testing.T) {
			got, bad := readCloseReason(tc.raw)
			if bad != nil || got != tc.want {
				t.Fatalf("got %q, rejection %+v", got, bad)
			}
		})
	}
	secret := "do-not-echo"
	invalid := []struct {
		name string
		raw  any
	}{
		{"empty", ""},
		{"blank", " \n\t "},
		{"over the limit", secret + strings.Repeat("x", closeReasonMaxRunes)},
		{"NUL cannot reach jsonb", secret + "\x00"},
		{"control character", secret + "\x1b[2J"},
		{"number", 7},
		{"array", []any{secret}},
	}
	for _, tc := range invalid {
		t.Run(tc.name, func(t *testing.T) {
			_, bad := readCloseReason(tc.raw)
			if bad == nil {
				t.Fatal("expected a rejection")
			}
			if bad.status != http.StatusBadRequest {
				t.Fatalf("status %d", bad.status)
			}
			if strings.Contains(fmt.Sprintf("%+v", *bad), secret) {
				t.Fatalf("rejection echoes the reason: %+v", *bad)
			}
		})
	}
}
