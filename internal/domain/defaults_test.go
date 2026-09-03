package domain

import (
	"encoding/json"
	"reflect"
	"testing"
)

// Cases port the source contract at the consistency pin;
// each cites the original `it(...)` name it mirrors.

func schemaFromJSON(t *testing.T, doc string) *InputSchema {
	t.Helper()
	var s InputSchema
	if err := json.Unmarshal([]byte(doc), &s); err != nil {
		t.Fatalf("schema: %v", err)
	}
	return &s
}

func valueFromJSON(t *testing.T, doc string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(doc), &v); err != nil {
		t.Fatalf("value: %v", err)
	}
	return v
}

var settingsSchema = `{
	"type":"object",
	"properties":{
		"workingHoursStart":{"type":"string","default":"09:00"},
		"workingHoursEnd":{"type":"string","default":"17:00"},
		"timeZone":{"type":"string","default":"UTC"},
		"snoozeHours":{"type":"number","default":12}
	},
	"required":["workingHoursStart","workingHoursEnd","timeZone"]
}`

func TestFillsDeclaredDefaultsIntoEmptyPayload(t *testing.T) {
	// "fills declared defaults into an empty payload"
	got := ApplyInputDefaults(schemaFromJSON(t, settingsSchema), map[string]any{})
	want := valueFromJSON(t, `{"workingHoursStart":"09:00","workingHoursEnd":"17:00","timeZone":"UTC","snoozeHours":12}`)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestSuppliedValueWinsOverDefault(t *testing.T) {
	// "lets a supplied value win over its default"
	got := ApplyInputDefaults(schemaFromJSON(t, settingsSchema), valueFromJSON(t, `{"timeZone":"America/Bogota"}`))
	if got.(map[string]any)["timeZone"] != "America/Bogota" || got.(map[string]any)["workingHoursStart"] != "09:00" {
		t.Fatalf("unexpected: %v", got)
	}
}

func TestExplicitNullAndFalseAreSuppliedNotAbsent(t *testing.T) {
	// "treats explicit null and false as supplied, not absent"
	schema := schemaFromJSON(t, `{"type":"object","properties":{
		"enabled":{"type":"boolean","default":true},
		"note":{"type":"string","default":"fallback"}
	}}`)
	got := ApplyInputDefaults(schema, valueFromJSON(t, `{"enabled":false,"note":null}`)).(map[string]any)
	if got["enabled"] != false || got["note"] != nil {
		t.Fatalf("null/false must win over defaults: %v", got)
	}
}

func TestNeverMutatesCallerPayload(t *testing.T) {
	// "never mutates the caller payload"
	supplied := map[string]any{"timeZone": "Asia/Tokyo"}
	_ = ApplyInputDefaults(schemaFromJSON(t, settingsSchema), supplied)
	if len(supplied) != 1 || supplied["timeZone"] != "Asia/Tokyo" {
		t.Fatalf("caller payload mutated: %v", supplied)
	}
}

func TestTriggerPayloadSatisfiesRequiredSettings(t *testing.T) {
	// "lets a trigger payload satisfy required settings that have defaults" —
	// the regression the feature exists for: a webhook run supplies the
	// event, never the declared fields.
	schema := schemaFromJSON(t, settingsSchema)
	trigger := valueFromJSON(t, `{"triggeredBy":"pagerduty_incident","event":{"incidentId":"P1"}}`)

	resolved := ApplyInputDefaults(schema, trigger)
	if errs := ValidateInputValue(schema, resolved, "$"); len(errs) != 0 {
		t.Fatalf("resolved trigger payload must validate, got %v", errs)
	}
	m := resolved.(map[string]any)
	if m["triggeredBy"] != "pagerduty_incident" || m["workingHoursStart"] != "09:00" {
		t.Fatalf("trigger keys and defaults must coexist: %v", m)
	}
	if errs := ValidateInputValue(schema, trigger, "$"); len(errs) == 0 {
		t.Fatal("the raw trigger payload must still fail without defaults")
	}
}

func TestRecursesIntoNestedObjects(t *testing.T) {
	// "recurses into nested objects"
	schema := schemaFromJSON(t, `{"type":"object","properties":{
		"window":{"type":"object","properties":{
			"start":{"type":"string","default":"09:00"},
			"end":{"type":"string","default":"17:00"}
		}}
	}}`)
	got := ApplyInputDefaults(schema, valueFromJSON(t, `{"window":{"start":"08:00"}}`))
	want := valueFromJSON(t, `{"window":{"start":"08:00","end":"17:00"}}`)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	materialized := ApplyInputDefaults(schema, map[string]any{})
	if !reflect.DeepEqual(materialized, valueFromJSON(t, `{"window":{"start":"09:00","end":"17:00"}}`)) {
		t.Fatalf("absent nested object must materialize from child defaults: %v", materialized)
	}
}

func TestAbsentOptionalObjectStaysAbsent(t *testing.T) {
	// "leaves an absent optional object absent when nothing defaults it"
	schema := schemaFromJSON(t, `{"type":"object","properties":{
		"extras":{"type":"object","properties":{"note":{"type":"string"}}}
	}}`)
	got := ApplyInputDefaults(schema, map[string]any{}).(map[string]any)
	if _, exists := got["extras"]; exists {
		t.Fatalf("optional section must not materialize as {}: %v", got)
	}
}

func TestWrongTypedDefaultPassesThroughForValidator(t *testing.T) {
	// "passes a wrong-typed default through for the validator to report"
	schema := schemaFromJSON(t, `{"type":"object","default":"not-an-object"}`)
	got := ApplyInputDefaults(schema, nilValue())
	if got != "not-an-object" {
		t.Fatalf("wrong-typed default must pass through untouched: %v", got)
	}
	if errs := ValidateInputValue(schema, got, "$"); len(errs) == 0 {
		t.Fatal("the validator must still report the type error")
	}
}

func TestPrototypeShapedKeysAreOwnData(t *testing.T) {
	// "treats prototype-shaped field names as own JSON data" — free in Go,
	// pinned so the guarantee survives refactors.
	schema := schemaFromJSON(t, `{"type":"object","properties":{
		"__proto__":{"type":"string","default":"safe"}
	}}`)
	got := ApplyInputDefaults(schema, map[string]any{}).(map[string]any)
	if got["__proto__"] != "safe" {
		t.Fatalf("__proto__ must behave as plain data: %v", got)
	}
}

// nilValue mirrors passing `undefined` from the caller side: the engine
// substitutes an empty object before calling, but the resolver itself must
// tolerate a bare missing top-level value the way the contract does.
func nilValue() any {
	var v any
	return v
}
