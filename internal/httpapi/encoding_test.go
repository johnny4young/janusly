package httpapi

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// A strict decoder cannot protect a route that discards its error. Keep this
// source-level ratchet beside the decoder so every ordinary JSON handler must
// explicitly choose and test its public failure envelope before doing work.
func TestDecodeBodyErrorsAreNeverDiscarded(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	set := token.NewFileSet()
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		file, parseErr := parser.ParseFile(set, path, nil, 0)
		if parseErr != nil {
			t.Fatalf("parse %s: %v", path, parseErr)
		}
		ast.Inspect(file, func(node ast.Node) bool {
			assignment, ok := node.(*ast.AssignStmt)
			if !ok || len(assignment.Lhs) != 1 || len(assignment.Rhs) != 1 {
				return true
			}
			blank, ok := assignment.Lhs[0].(*ast.Ident)
			call, isCall := assignment.Rhs[0].(*ast.CallExpr)
			callee, isIdent := func() (*ast.Ident, bool) {
				if !isCall {
					return nil, false
				}
				identifier, valid := call.Fun.(*ast.Ident)
				return identifier, valid
			}()
			if ok && blank.Name == "_" && isIdent &&
				(callee.Name == "decodeBody" || callee.Name == "decodeBodyBounded") {
				t.Errorf("%s discards %s error", set.Position(assignment.Pos()), callee.Name)
			}
			return true
		})
	}
}

// requireLiteralInternalErrors walks the given httpapi source files and
// fails when an opError(..., "internal_error", message, ...) call builds its
// message dynamically: public 500 envelopes may use stable literal
// diagnostics but must never compose a database/provider error into the body.
func requireLiteralInternalErrors(t *testing.T, label string, paths ...string) {
	t.Helper()
	set := token.NewFileSet()
	for _, path := range paths {
		file, err := parser.ParseFile(set, path, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
		ast.Inspect(file, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok || len(call.Args) < 3 {
				return true
			}
			callee, ok := call.Fun.(*ast.Ident)
			if !ok || callee.Name != "opError" {
				return true
			}
			code, ok := call.Args[1].(*ast.BasicLit)
			if !ok {
				return true
			}
			decoded, err := strconv.Unquote(code.Value)
			if err != nil || decoded != "internal_error" {
				return true
			}
			if _, literal := call.Args[2].(*ast.BasicLit); !literal {
				t.Errorf("%s builds %s internal_error message dynamically", set.Position(call.Args[2].Pos()), label)
			}
			return true
		})
	}
}

// Provider callbacks and normalized event-ingest routes are externally
// reachable.
func TestExternalTriggerInternalErrorsAreRedacted(t *testing.T) {
	requireLiteralInternalErrors(t, "an external", "pagerduty.go", "webhooks.go", "triggeringest.go")
}

// Governed recovery carries long-lived operator/provider evidence and touches
// PostgreSQL on every read and mutation. Its public 500 envelopes must not
// reflect wrapped SQL, evidence, or provider details back to the browser.
func TestGovernedRecoveryInternalErrorsAreRedacted(t *testing.T) {
	requireLiteralInternalErrors(t, "a recovery", "recoveryreads.go", "semanticrecovery.go")
}

// Every generic 500 in the HTTP package uses one stable literal and no params.
// The encoder also normalizes direct construction as defense in depth, but the
// source ratchet keeps accidental SQL/provider interpolation out of handlers.
func TestEveryHTTPInternalErrorIsRedacted(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	set := token.NewFileSet()
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		file, parseErr := parser.ParseFile(set, path, nil, 0)
		if parseErr != nil {
			t.Fatalf("parse %s: %v", path, parseErr)
		}
		ast.Inspect(file, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			callee, ok := call.Fun.(*ast.Ident)
			if !ok {
				return true
			}
			var codeIndex, messageIndex, paramsIndex int
			switch callee.Name {
			case "opError":
				codeIndex, messageIndex, paramsIndex = 1, 2, 3
			case "writeV1Error":
				codeIndex, messageIndex, paramsIndex = 3, 4, 5
			default:
				return true
			}
			if len(call.Args) <= paramsIndex {
				return true
			}
			code, ok := call.Args[codeIndex].(*ast.BasicLit)
			if !ok {
				return true
			}
			decodedCode, decodeErr := strconv.Unquote(code.Value)
			if decodeErr != nil || decodedCode != "internal_error" {
				return true
			}
			message, literal := call.Args[messageIndex].(*ast.BasicLit)
			decodedMessage := ""
			if literal {
				decodedMessage, _ = strconv.Unquote(message.Value)
			}
			if !literal || decodedMessage != "Internal error" {
				t.Errorf("%s must use the stable Internal error literal", set.Position(call.Args[messageIndex].Pos()))
			}
			params, isNil := call.Args[paramsIndex].(*ast.Ident)
			if !isNil || params.Name != "nil" {
				t.Errorf("%s must not attach params to internal_error", set.Position(call.Args[paramsIndex].Pos()))
			}
			return true
		})
	}
}

func TestInternalErrorEncodersNormalizeDirectConstruction(t *testing.T) {
	result := opError(http.StatusTeapot, "internal_error",
		"Internal error: database secret", map[string]any{"sql": "secret"})
	if result.status != http.StatusInternalServerError || result.message != "Internal error" || result.params != nil {
		t.Fatalf("opError did not normalize internal details: %+v", result)
	}

	unversioned := httptest.NewRecorder()
	writeUnversioned(unversioned, opResult{
		status: http.StatusOK, code: "internal_error", data: map[string]any{"secret": true},
		message: "provider secret", params: map[string]any{"secret": true},
		unversionedExtras: map[string]any{"leak": true},
	})
	if unversioned.Code != http.StatusInternalServerError {
		t.Fatalf("unversioned internal error status=%d", unversioned.Code)
	}
	if body := unversioned.Body.String(); body != "{\"code\":\"internal_error\",\"error\":\"Internal error\"}\n" {
		t.Fatalf("unversioned internal error leaked or drifted: %s", body)
	}

	versionedResult := httptest.NewRecorder()
	writeVersioned(versionedResult, "request-1", opResult{
		status: http.StatusOK, code: "internal_error", data: map[string]any{"secret": true},
		message: "provider secret", params: map[string]any{"secret": true},
		unversionedExtras: map[string]any{"leak": true},
	})
	if versionedResult.Code != http.StatusInternalServerError {
		t.Fatalf("versioned result internal error status=%d", versionedResult.Code)
	}
	if body := versionedResult.Body.String(); strings.Contains(body, "secret") || !strings.Contains(body, `"message":"Internal error"`) {
		t.Fatalf("versioned result internal error leaked or drifted: %s", body)
	}

	versioned := httptest.NewRecorder()
	writeV1Error(versioned, "request-1", http.StatusOK,
		"internal_error", "provider secret", map[string]any{"secret": true})
	if versioned.Code != http.StatusInternalServerError {
		t.Fatalf("versioned internal error status=%d", versioned.Code)
	}
	body := versioned.Body.String()
	if strings.Contains(body, "secret") || !strings.Contains(body, `"message":"Internal error"`) {
		t.Fatalf("versioned internal error leaked or drifted: %s", body)
	}
}

func TestDecodeBodyRequiresExactlyOneStrictJSONValue(t *testing.T) {
	type body struct {
		Prompt string `json:"prompt"`
	}
	tests := []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{name: "one object with trailing whitespace", raw: "{\"prompt\":\"safe\"}\n\t"},
		{name: "unknown field", raw: "{\"prompt\":\"safe\",\"secret\":true}", wantErr: true},
		{name: "second object", raw: "{\"prompt\":\"safe\"}{\"prompt\":\"ignored\"}", wantErr: true},
		{name: "second scalar", raw: "{\"prompt\":\"safe\"} true", wantErr: true},
		{name: "trailing garbage", raw: "{\"prompt\":\"safe\"} garbage", wantErr: true},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest("POST", "/strict", strings.NewReader(testCase.raw))
			var decoded body
			err := decodeBody(request, &decoded)
			if (err != nil) != testCase.wantErr {
				t.Fatalf("decodeBody error=%v, wantErr=%v", err, testCase.wantErr)
			}
			if !testCase.wantErr && decoded.Prompt != "safe" {
				t.Fatalf("decoded prompt=%q", decoded.Prompt)
			}
		})
	}
}

func TestDecodeBodyBoundedReadsThroughEOFToEnforceTheCap(t *testing.T) {
	type body struct {
		Prompt string `json:"prompt"`
	}
	raw := "{\"prompt\":\"safe\"}"
	for _, testCase := range []struct {
		name    string
		limit   int64
		wantErr bool
	}{
		{name: "exact limit", limit: int64(len(raw))},
		{name: "one byte over limit", limit: int64(len(raw) - 1), wantErr: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest("POST", "/bounded", strings.NewReader(raw))
			var decoded body
			err := decodeBodyBounded(request, &decoded, testCase.limit)
			if (err != nil) != testCase.wantErr {
				t.Fatalf("decodeBodyBounded error=%v, wantErr=%v", err, testCase.wantErr)
			}
		})
	}
}

func TestReadRawBodyEnforcesHardCap(t *testing.T) {
	t.Run("exact cap preserves bytes", func(t *testing.T) {
		request := httptest.NewRequest("POST", "/signed", strings.NewReader("abcd"))
		response := httptest.NewRecorder()
		raw, ok := readRawBody(response, request, 4)
		if !ok || string(raw) != "abcd" || response.Code != 200 {
			t.Fatalf("raw=%q ok=%v status=%d", raw, ok, response.Code)
		}
	})

	t.Run("oversized body is rejected rather than truncated", func(t *testing.T) {
		request := httptest.NewRequest("POST", "/signed", strings.NewReader("abcde"))
		response := httptest.NewRecorder()
		raw, ok := readRawBody(response, request, 4)
		if ok || raw != nil || response.Code != 413 {
			t.Fatalf("raw=%q ok=%v status=%d", raw, ok, response.Code)
		}
		body, err := io.ReadAll(response.Result().Body)
		if err != nil {
			t.Fatalf("read response: %v", err)
		}
		for _, expected := range []string{
			`"code":"server_request_failed"`,
			`"error":"Request body too large. Limit is 4 bytes"`,
		} {
			if !strings.Contains(string(body), expected) {
				t.Fatalf("response %s does not contain %s", body, expected)
			}
		}
	})
}
