package httpjson

import (
	"errors"
	"strings"
	"testing"
)

func TestDecodeEnforcesExactResponseCap(t *testing.T) {
	const document = `{"value":"ok"}`

	var decoded map[string]string
	if err := Decode(strings.NewReader(document), int64(len(document)), &decoded); err != nil {
		t.Fatalf("exact cap: %v", err)
	}
	if decoded["value"] != "ok" {
		t.Fatalf("decoded value: %#v", decoded)
	}

	err := Decode(strings.NewReader(document), int64(len(document)-1), &decoded)
	if !errors.Is(err, ErrResponseTooLarge) {
		t.Fatalf("cap + 1 must fail with ErrResponseTooLarge, got %v", err)
	}
}

func TestDecodeRejectsInvalidInputs(t *testing.T) {
	var decoded map[string]any
	if err := Decode(strings.NewReader(`{"value":`), 64, &decoded); err == nil {
		t.Fatal("malformed JSON must fail")
	}
	if err := Decode(strings.NewReader(`{}`), 0, &decoded); err == nil {
		t.Fatal("non-positive cap must fail")
	}
}
