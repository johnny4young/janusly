// contract generator — renders the side-effect-free v1 manifest into
// contract/openapi.json (OpenAPI 3.1). Deliberately does NOT import
// the HTTP server: the manifest is the contract's source of truth, and
// `make ci` fails on any drift between the checked-in document and a
// fresh render.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/johnny4young/janusly/internal/contract"
)

func main() {
	paths := map[string]map[string]any{}
	for _, route := range contract.Routes {
		path := strings.TrimPrefix(route.Path, "/v1")
		item, ok := paths[path]
		if !ok {
			item = map[string]any{}
			paths[path] = item
		}
		operation := map[string]any{
			"summary":     route.Summary,
			"operationId": operationID(route.Method, route.Path),
			"responses": map[string]any{
				"200": map[string]any{
					"description": "Success — the data payload inside the v1 envelope",
					"content": map[string]any{"application/json": map[string]any{
						"schema": map[string]any{
							"allOf": []any{
								map[string]any{"$ref": "#/components/schemas/V1Envelope"},
								map[string]any{"type": "object", "properties": map[string]any{
									"data": route.Response,
								}},
							},
						},
					}},
				},
				"default": map[string]any{
					"description": "Error — the v1 error envelope",
					"content": map[string]any{"application/json": map[string]any{
						"schema": map[string]any{"$ref": "#/components/schemas/V1ErrorEnvelope"},
					}},
				},
			},
		}
		if route.Request != nil {
			operation["requestBody"] = map[string]any{
				"required": true,
				"content": map[string]any{"application/json": map[string]any{
					"schema": route.Request,
				}},
			}
		}
		item[strings.ToLower(route.Method)] = operation
	}

	document := map[string]any{
		"openapi": "3.1.0",
		"info": map[string]any{
			"title":       "Janusly — v1 API",
			"version":     "0.1.0",
			"description": "Generated from the side-effect-free route manifest in internal/contract. Every response wraps in the v1 envelope; the envelope is documented once in components and referenced everywhere.",
		},
		"servers": []any{map[string]any{"url": "/v1", "description": "Version 1"}},
		"paths":   paths,
		"components": map[string]any{
			"schemas": map[string]any{
				"V1Envelope": map[string]any{
					"type":        "object",
					"description": "The v1 success envelope: apiVersion + requestId (echoed as X-Request-Id) around the data payload.",
					"properties": map[string]any{
						"apiVersion": map[string]any{"type": "string", "const": "v1"},
						"requestId":  map[string]any{"type": "string"},
					},
					"required": []any{"apiVersion", "requestId"},
				},
				"V1ErrorEnvelope": map[string]any{
					"type":        "object",
					"description": "The v1 error envelope: a stable code, a human message, and optional params.",
					"properties": map[string]any{
						"apiVersion": map[string]any{"type": "string", "const": "v1"},
						"requestId":  map[string]any{"type": "string"},
						"error": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"code":    map[string]any{"type": "string"},
								"message": map[string]any{"type": "string"},
								"params":  map[string]any{"type": "object"},
							},
							"required": []any{"code", "message"},
						},
					},
					"required": []any{"apiVersion", "requestId", "error"},
				},
			},
		},
	}

	rendered, err := marshalStable(document)
	if err != nil {
		fmt.Fprintln(os.Stderr, "render:", err)
		os.Exit(1)
	}
	if err := os.WriteFile("contract/openapi.json", rendered, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "write:", err)
		os.Exit(1)
	}
	fmt.Printf("contract/openapi.json: %d routes, %d bytes\n", len(contract.Routes), len(rendered))
}

func operationID(method, path string) string {
	clean := strings.NewReplacer("/", "_", "{", "", "}", "").Replace(strings.TrimPrefix(path, "/"))
	return strings.ToLower(method) + "_" + clean
}

// marshalStable renders deterministic JSON (sorted keys, stable
// indentation) so the drift guard compares bytes, not luck.
func marshalStable(value any) ([]byte, error) {
	// encoding/json already sorts map keys; MarshalIndent keeps the diff
	// readable. The sort import guards against future non-map ordering.
	_ = sort.Strings
	return json.MarshalIndent(value, "", "  ")
}
