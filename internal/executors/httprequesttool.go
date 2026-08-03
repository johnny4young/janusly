// The `http.request` registered tool (reference packages/engine/src/
// tools/http.ts): one guarded outbound HTTP call for tool nodes and the
// agent planner. Invariant (AGENTS.md "HTTP/SSRF"): it MUST go through
// FetchHTTPTarget — the pinned dialer prevents DNS rebinding; a direct
// client would bypass SSRF protection for untrusted URLs. Write-side at
// registration (validation/dry-run skip); the runtime dry-run classifier
// still refines safe GET/HEAD reads.
package executors

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"

	"github.com/johnny4young/janusly/internal/tools"
)

func httpRequestDefinition() tools.Definition {
	return tools.Definition{
		Name:        "http.request",
		Description: "Make an HTTP request to an external API.",
		Required:    []string{"url"},
		Optional:    []string{"method", "headers", "body", "timeoutMs", "maxResponseBytes", "maxRedirects"},
		Fields: []tools.Field{
			{Name: "url", Type: "string", Required: true},
			{Name: "method", Type: "string"},
			{Name: "headers", Type: "object"},
			{Name: "body", Type: "object"},
			{Name: "timeoutMs", Type: "number"},
			{Name: "maxResponseBytes", Type: "number"},
			{Name: "maxRedirects", Type: "number"},
		},
		InputExample: map[string]any{"url": "https://example.com", "method": "GET"},
		WriteSide:    true,
		Execute:      executeHTTPRequestTool,
	}
}

func executeHTTPRequestTool(ctx context.Context, input map[string]any) (map[string]any, error) {
	rawURL, _ := input["url"].(string)
	if rawURL == "" {
		return nil, fmt.Errorf("Invalid tool input for http.request: url is required") //nolint:staticcheck // tool error shape
	}
	method, _ := input["method"].(string)
	headers := map[string]string{}
	if rawHeaders, ok := input["headers"].(map[string]any); ok {
		for name, value := range rawHeaders {
			if text, ok := value.(string); ok {
				headers[name] = text
			}
		}
	}
	var body []byte
	if raw, present := input["body"]; present && raw != nil {
		encoded, err := json.Marshal(raw)
		if err != nil {
			return nil, fmt.Errorf("Invalid tool input for http.request: body is not serializable") //nolint:staticcheck // tool error shape
		}
		body = encoded
	}
	intOf := func(field string) int {
		value, _ := input[field].(float64)
		return int(value)
	}
	result, err := FetchHTTPTarget(ctx, rawURL, FetchOptions{
		Method: method, Headers: headers, Body: body,
		TimeoutMs:        intOf("timeoutMs"),
		MaxResponseBytes: intOf("maxResponseBytes"),
		MaxRedirects:     intOf("maxRedirects"),
	})
	if err != nil {
		return nil, err
	}
	output := map[string]any{
		"statusCode": result.StatusCode, "ok": result.Ok, "body": result.Body,
	}
	maps.Copy(output, projectHTTPJSON([]byte(result.Body), result.ContentType))
	return output, nil
}
