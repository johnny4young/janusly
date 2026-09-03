package main

import "testing"

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
