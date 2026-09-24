package main

import (
	"bytes"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/johnny4young/janusly/internal/ai"
)

func TestFormatNumberEmitsStableDecimalLiterals(t *testing.T) {
	tests := []struct {
		name  string
		value float64
		want  string
	}{
		{name: "zero", value: 0, want: "0"},
		{name: "integer", value: 10, want: "10"},
		{name: "fraction", value: 12.5, want: "12.5"},
		{name: "binary artifact", value: 0.1 * 3, want: "0.3"},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			if got := formatNumber(testCase.value); got != testCase.want {
				t.Fatalf("formatNumber(%v) = %q, want %q", testCase.value, got, testCase.want)
			}
		})
	}
}

func TestWriteCatalogJSONShape(t *testing.T) {
	var out bytes.Buffer
	prices := map[string]ai.ModelPrice{
		"claude-sonnet-5": {InputUsdPer1M: 2, OutputUsdPer1M: 10, CacheWrite5mUsdPer1M: 2.5, CacheReadUsdPer1M: 0.2},
		"claude-fable-5":  {InputUsdPer1M: 10, OutputUsdPer1M: 50},
	}
	if err := writeCatalogJSON(&out, "2026-09-24", prices); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("output is not JSON: %v\n%s", err, out.String())
	}
	want := map[string]any{
		"snapshotDate": "2026-09-24",
		"models": map[string]any{
			"claude-sonnet-5": map[string]any{"inputUsdPer1M": 2.0, "outputUsdPer1M": 10.0},
			"claude-fable-5":  map[string]any{"inputUsdPer1M": 10.0, "outputUsdPer1M": 50.0},
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("catalog JSON = %v, want %v", got, want)
	}
}
