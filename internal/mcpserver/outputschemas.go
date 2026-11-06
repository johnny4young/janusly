package mcpserver

import (
	"slices"

	"github.com/google/jsonschema-go/jsonschema"
)

// outputSchemas describe each tool's structuredContent top level so a client
// can rely on field names and types. Nested values stay open; the SDK checks
// every successful result against its schema.
var outputSchemas = map[string]*jsonschema.Schema{
	"workflows.save": outputObject(fields{
		"workflowId": {kind: "string", required: true}, "versionId": {kind: "string", required: true},
		"version": {kind: "integer", required: true},
	}),
	"runs.start": outputObject(fields{
		"runId": {kind: "string", required: true}, "replayed": {kind: "boolean"},
	}),
	"runs.status": outputObject(fields{
		"runId": {kind: "string", required: true}, "status": {kind: "string", required: true},
		"nodes": {kind: "object", required: true}, "outputAvailable": {kind: "boolean", required: true},
	}),
	"runs.inspect": outputObject(fields{
		"runId": {kind: "string", required: true}, "status": {kind: "string", required: true},
		"inputAvailable": {kind: "boolean", required: true}, "outputAvailable": {kind: "boolean", required: true},
		"nodes": {kind: "array", required: true}, "recentEvents": {kind: "array", required: true},
	}),
	"runs.list":      pageObject("runs"),
	"workflows.list": pageObject("workflows"),
	"dlq.list":       pageObject("deadLetters"),
	"dlq.redrive": outputObject(fields{
		"redriven": {kind: "boolean", required: true}, "deadLetterId": {kind: "string", required: true},
	}),
	"workflows.assure": outputObject(fields{
		"workflowId": {kind: "string", required: true}, "name": {kind: "string", required: true},
		"versionId": {kind: "string", required: true}, "version": {kind: "integer", required: true},
		"status": {kind: "string", required: true}, "validation": {kind: "object", required: true},
		"readiness": {kind: "object"}, "intent": {kind: "object"}, "recovery": {kind: "object"},
		"qualification": {kind: "object"},
	}),
	"operations.brief": outputObject(fields{
		"version": {kind: "string", required: true}, "generatedAt": {kind: "string", required: true},
		"actions": {kind: "array", nullable: true, required: true}, "warnings": {kind: "array", nullable: true, required: true},
	}),
	"workflows.propose": outputObject(fields{
		"mode": {kind: "string", required: true}, "catalogVersion": {kind: "string", required: true},
		"catalogWarnings": {kind: "array", required: true}, "brief": {kind: "object", required: true},
		"clarifyingQuestions": {kind: "array", required: true}, "bindings": {kind: "object", required: true},
		"applicable": {kind: "boolean", required: true}, "workflow": {kind: "object", required: true},
		"assurance": {kind: "object", required: true}, "document": {kind: "object"},
	}),
	"recovery.cases.inspect": outputObject(fields{
		"case": {kind: "object", required: true}, "transitions": {kind: "array", required: true},
		"artifacts": {kind: "array", required: true}, "autonomy": {required: true},
		"approvalRequiredOutsideMcp": {kind: "boolean", required: true},
	}),
	"recovery.cases.diagnose": outputObject(fields{
		"case": {kind: "object", required: true}, "mode": {kind: "string", required: true},
		"candidates": {kind: "array", required: true}, "approvalCreated": {kind: "boolean", required: true},
		"diagnosis": {kind: "object"},
	}),
	"recovery.cases.validate": outputObject(fields{
		"case": {kind: "object", required: true}, "validation": {kind: "object", required: true},
		"passed": {kind: "boolean", required: true}, "approvalCreated": {kind: "boolean", required: true},
	}),
	"recovery.cases.apply": outputObject(fields{
		"runId": {kind: "string", required: true}, "sourceNodeId": {kind: "string", required: true},
		"decision": {kind: "string", required: true}, "resumed": {kind: "boolean", required: true},
		"resolvedCaseIds": {kind: "array", nullable: true, required: true},
	}),
	"catalog.describe": outputObject(fields{
		"catalogVersion": {kind: "string", required: true},
		"sections":       {kind: "array"}, "nodeTypes": {kind: "array"}, "toolCount": {kind: "integer"},
		"credentialCount": {kind: "integer"}, "documentShape": {kind: "string"}, "templates": {kind: "string"},
		"tools": {kind: "array"}, "tool": {kind: "object"}, "credentials": {kind: "array"},
		"mcpTools": {kind: "array"}, "warnings": {kind: "array"}, "triggers": {kind: "array"},
		"subworkflows": {kind: "array"},
	}),
	"workflows.validate": outputObject(fields{
		"valid": {kind: "boolean", required: true}, "issues": {kind: "array", required: true},
		"readiness": {kind: "object"}, "bindings": {kind: "object"}, "bindingsWithheld": {kind: "string"},
	}),
}

type field struct {
	kind     string
	nullable bool
	required bool
}

type fields map[string]field

func outputObject(spec fields) *jsonschema.Schema {
	schema := &jsonschema.Schema{Type: "object", Properties: map[string]*jsonschema.Schema{}}
	for name, field := range spec {
		property := &jsonschema.Schema{}
		switch {
		case field.kind != "" && field.nullable:
			property.Types = []string{field.kind, "null"}
		case field.kind != "":
			property.Type = field.kind
		}
		schema.Properties[name] = property
		if field.required {
			schema.Required = append(schema.Required, name)
		}
	}
	slices.Sort(schema.Required)
	return schema
}

func pageObject(rows string) *jsonschema.Schema {
	return outputObject(fields{
		rows: {kind: "array", required: true}, "hasMore": {kind: "boolean", required: true},
		"nextCursor": {kind: "string"},
	})
}
