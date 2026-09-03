package engine

import (
	"encoding/json"
	"github.com/johnny4young/janusly/internal/grammar"
	"reflect"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/domain"
)

func wfFromJSON(t *testing.T, doc string) *domain.Workflow {
	t.Helper()
	wf, issues := domain.Parse([]byte(doc))
	if wf == nil {
		t.Fatalf("fixture must parse: %+v", issues)
	}
	return wf
}

const diamondDoc = `{"nodes":[
	{"id":"root","type":"noop","config":{}},
	{"id":"left","type":"noop","config":{}},
	{"id":"right","type":"noop","config":{}},
	{"id":"join","type":"noop","config":{}}
],"edges":[
	{"from":"root","to":"left"},{"from":"root","to":"right"},
	{"from":"left","to":"join"},{"from":"right","to":"join"}
]}`

func TestReadySuccessorsTable(t *testing.T) {
	diamond := wfFromJSON(t, diamondDoc)
	linear := wfFromJSON(t, `{"nodes":[
		{"id":"a","type":"noop","config":{}},{"id":"b","type":"noop","config":{}}
	],"edges":[{"from":"a","to":"b"}]}`)

	cases := []struct {
		name     string
		wf       *domain.Workflow
		statuses map[string]string
		want     []string
	}{
		{"linear successor unblocks", linear,
			map[string]string{"a": "succeeded", "b": "pending"}, []string{"b"}},
		{"linear successor waits", linear,
			map[string]string{"a": "running", "b": "pending"}, nil},
		{"diamond join needs BOTH branches", diamond,
			map[string]string{"root": "succeeded", "left": "succeeded", "right": "running", "join": "pending"}, nil},
		{"diamond join unblocks on full fan-in", diamond,
			map[string]string{"root": "succeeded", "left": "succeeded", "right": "succeeded", "join": "pending"}, []string{"join"}},
		{"a skipped branch satisfies its edge", diamond,
			map[string]string{"root": "succeeded", "left": "succeeded", "right": "skipped", "join": "pending"}, []string{"join"}},
		{"non-pending nodes are never re-queued", diamond,
			map[string]string{"root": "succeeded", "left": "queued", "right": "queued", "join": "pending"}, nil},
		{"a pending root is unconditionally ready", linear,
			map[string]string{"a": "pending", "b": "pending"}, []string{"a"}},
		{"failed predecessor blocks forever", linear,
			map[string]string{"a": "failed", "b": "pending"}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := readySuccessors(tc.wf, tc.statuses)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestBoundPayloadPassesSmallThrough(t *testing.T) {
	raw := json.RawMessage(`{"ok":true}`)
	if got := grammar.BoundPersistPayload(raw, 1000); string(got) != string(raw) {
		t.Fatalf("small payload must pass untouched: %s", got)
	}
}

func TestBoundPayloadReplacesOversizeWithSentinel(t *testing.T) {
	big, _ := json.Marshal(map[string]string{"blob": strings.Repeat("x", 5000)})
	bounded := grammar.BoundPersistPayload(big, 1000)

	var sentinel struct {
		Truncated     bool   `json:"__truncated"`
		OriginalBytes int    `json:"originalBytes"`
		MaxBytes      int    `json:"maxBytes"`
		Preview       string `json:"preview"`
	}
	if err := json.Unmarshal(bounded, &sentinel); err != nil {
		t.Fatalf("sentinel must be well-formed JSON: %v", err)
	}
	if !sentinel.Truncated || sentinel.OriginalBytes != len(big) || sentinel.MaxBytes != 1000 {
		t.Fatalf("sentinel fields wrong: %+v", sentinel)
	}
	// The preview holds the leading half-cap bytes — enough to identify the
	// payload's shape without inflating the row back.
	if len(sentinel.Preview) != 500 || !strings.HasPrefix(string(big), sentinel.Preview) {
		t.Fatalf("preview must be the leading %d bytes, got %d", 500, len(sentinel.Preview))
	}
}

func TestBoundPayloadPreviewNeverSplitsARune(t *testing.T) {
	// Multibyte content aligned so a naive byte slice would cut mid-rune.
	big, _ := json.Marshal(strings.Repeat("é", 4000))
	bounded := grammar.BoundPersistPayload(big, 1001)
	var sentinel struct {
		Preview string `json:"preview"`
	}
	if err := json.Unmarshal(bounded, &sentinel); err != nil {
		t.Fatalf("sentinel with multibyte preview must re-marshal cleanly: %v", err)
	}
	if !json.Valid(bounded) {
		t.Fatal("bounded payload must stay valid JSON")
	}
}
