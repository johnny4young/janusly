package main

import (
	"net/url"
	"testing"
)

func TestSeedQueryEncoding(t *testing.T) {
	got := withQuery("/v1/workflows/latest", url.Values{"workflowId": {"demo/one & two"}})
	if got != "/v1/workflows/latest?workflowId=demo%2Fone+%26+two" {
		t.Fatalf("query = %q", got)
	}
}
