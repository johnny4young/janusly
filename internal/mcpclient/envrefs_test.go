package mcpclient

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
)

func TestParseEnvRefsClosedBoundedContract(t *testing.T) {
	t.Parallel()
	valid, err := ParseEnvRefs([]byte(`{
		"X-Api-Key":{"kind":"env","name":"  ACME_API_TOKEN  "},
		"SECOND_TOKEN":{"kind":"env","name":"SECOND_TOKEN_SOURCE"}
	}`))
	if err != nil || len(valid) != 2 || valid["X-Api-Key"].Name != "ACME_API_TOKEN" {
		t.Fatalf("valid refs: %+v %v", valid, err)
	}
	for _, empty := range [][]byte{nil, []byte(""), []byte("null"), []byte("{}")} {
		refs, err := ParseEnvRefs(empty)
		if err != nil || len(refs) != 0 {
			t.Fatalf("empty refs %q: %+v %v", empty, refs, err)
		}
	}

	tooMany := make(map[string]EnvRef, MaxEnvRefs+1)
	for index := 0; index <= MaxEnvRefs; index++ {
		tooMany[fmt.Sprintf("KEY_%03d", index)] = EnvRef{Kind: "env", Name: "ACME_TOKEN"}
	}
	tooManyJSON, err := json.Marshal(tooMany)
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string][]byte{
		"array":             []byte(`[]`),
		"scalar":            []byte(`"bad"`),
		"bad key":           []byte(`{"bad.key":{"kind":"env","name":"ACME_TOKEN"}}`),
		"wrong kind":        []byte(`{"TOKEN":{"kind":"managed","name":"ACME_TOKEN"}}`),
		"missing name":      []byte(`{"TOKEN":{"kind":"env"}}`),
		"extra field":       []byte(`{"TOKEN":{"kind":"env","name":"ACME_TOKEN","value":"secret"}}`),
		"invalid env name":  []byte(`{"TOKEN":{"kind":"env","name":"ACME TOKEN"}}`),
		"excessive entries": tooManyJSON,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := ParseEnvRefs(raw); !errors.Is(err, ErrEnvRefsInvalid) {
				t.Fatalf("expected closed-contract error, got %v", err)
			}
		})
	}
}
