package mcpserver

import (
	"slices"

	"github.com/google/jsonschema-go/jsonschema"
)

// outputSchemas describe each tool's structuredContent top level so a client
// can rely on field names and types. Nested values stay open; the SDK checks
// every successful result against its schema.
var outputSchemas = map[string]*jsonschema.Schema{
	"drafts.save": outputObject(fields{
		"draftId": {kind: "string", required: true}, "workflowId": {kind: "string", required: true},
		"digest": {kind: "string", required: true}, "unchanged": {kind: "boolean", required: true},
		"newWorkflow": {kind: "boolean", required: true}, "fixtures": {kind: "integer", required: true},
		"validation": {kind: "object", required: true}, "next": {kind: "string"},
	}),
	"sessions.to_draft": outputObject(fields{
		"draftId": {kind: "string", required: true}, "workflowId": {kind: "string", required: true},
		"digest": {kind: "string", required: true}, "conversion": {kind: "object", required: true},
		"agents": {kind: "array", required: true}, "mcpServers": {kind: "array", required: true},
		"placeholders": {kind: "array", required: true}, "next": {kind: "string"},
	}),
	"drafts.get": outputObject(fields{
		"draftId": {kind: "string", required: true}, "workflowId": {kind: "string", required: true},
		"digest": {kind: "string", required: true}, "baseVersionId": {kind: "string"},
		"createdBy": {kind: "string"}, "createdAt": {kind: "string"},
		"document": {kind: "object", required: true}, "fixtures": {kind: "array", required: true},
	}),
	"drafts.list": pageObject("drafts"),
	"workflows.test": outputObject(fields{
		"runId": {kind: "string", required: true}, "writesSuppressed": {kind: "boolean", required: true}, "next": {kind: "string"},
	}),
	"workflows.qualify":  qualificationObject(),
	"qualifications.get": qualificationObject(),
	"workflows.publish": outputObject(fields{
		"status": {kind: "string", required: true}, "workflowId": {kind: "string", required: true},
		"versionId": {kind: "string"}, "version": {kind: "integer"}, "publishRequestId": {kind: "string"},
		"reasons": {kind: "array"}, "message": {kind: "string"}, "changes": {kind: "object"},
		"expiresAt": {kind: "string"}, "next": {kind: "string"},
	}),
	"publish.status": outputObject(fields{
		"publishRequestId": {kind: "string", required: true}, "workflowId": {kind: "string", required: true},
		"draftId": {kind: "string", required: true}, "status": {kind: "string", required: true},
		"reasons": {kind: "array", required: true}, "expiresAt": {kind: "string", required: true},
		"versionId": {kind: "string"}, "decidedAt": {kind: "string"}, "reason": {kind: "string"},
	}),
	"credentials.request": outputObject(fields{
		"name": {kind: "string", required: true}, "kind": {kind: "string"},
		"setupUrl": {kind: "string", required: true}, "message": {kind: "string", required: true},
	}),
	"agent.info": outputObject(fields{
		"kind": {kind: "string", required: true}, "organizationId": {kind: "string", required: true},
		"capabilities": {kind: "array", required: true}, "tools": {kind: "array", required: true},
		"permissions": {kind: "array", required: true}, "scope": {kind: "object", required: true},
		"clientId": {kind: "string"}, "name": {kind: "string"}, "missingPermissions": {kind: "array"},
		"expiresAt": {kind: "string"}, "rateLimitPerMinute": {kind: "integer"},
	}),
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
		"runId": {kind: "string"}, "runVersion": {kind: "integer"}, "latestVersion": {kind: "integer"},
		"staleVersion": {kind: "boolean"}, "hint": {kind: "string"},
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
	"workflows.get": outputObject(fields{
		"workflowId": {kind: "string", required: true}, "name": {kind: "string", required: true},
		"status": {kind: "string", required: true}, "versions": {kind: "array", required: true},
		"schedules": {kind: "array", required: true}, "version": {kind: "integer"},
		"versionId": {kind: "string"}, "document": {kind: "object"},
	}),
	"workflows.rollback": outputObject(fields{
		"workflowId": {kind: "string", required: true}, "versionId": {kind: "string", required: true},
		"version": {kind: "integer", required: true}, "sourceVersion": {kind: "integer", required: true},
	}),
	"workflows.deactivate": activeObject(),
	"workflows.reactivate": activeObject(),
	"workflows.pause": outputObject(fields{
		"workflowId": {kind: "string", required: true}, "status": {kind: "string", required: true},
		"changed": {kind: "boolean", required: true},
	}),
	"workflows.resume": outputObject(fields{
		"workflowId": {kind: "string", required: true}, "status": {kind: "string", required: true},
		"changed": {kind: "boolean", required: true}, "backfilled": {kind: "integer", required: true},
		"failed": {kind: "integer", required: true}, "remaining": {kind: "integer", required: true},
	}),
	"runs.output": outputObject(fields{
		"runId": {kind: "string", required: true}, "status": {kind: "string", required: true},
		"workflowVersionId": {kind: "string", required: true}, "output": {},
		"steps": {kind: "object", required: true},
	}),
	"runs.cancel": outputObject(fields{
		"runId": {kind: "string", required: true}, "status": {kind: "string", required: true},
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

func activeObject() *jsonschema.Schema {
	return outputObject(fields{
		"workflowId": {kind: "string", required: true}, "active": {kind: "boolean", required: true},
	})
}

func qualificationObject() *jsonschema.Schema {
	return outputObject(fields{
		"qualificationId": {kind: "string", required: true}, "draftId": {kind: "string", required: true},
		"digest": {kind: "string", required: true}, "status": {kind: "string", required: true},
		"checks": {kind: "array", required: true}, "fixtureRuns": {kind: "array", required: true},
		"createdAt": {kind: "string"}, "next": {kind: "string"},
	})
}
