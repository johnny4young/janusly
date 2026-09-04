// Package authoring owns the exact capability graph used to create and bind
// workflow proposals. The graph is tenant-scoped and deliberately contains no
// secret values: AI, UI, runtime validation and MCP consume the same bounded
// projection rather than maintaining independent lists of what is callable.
package authoring

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/mcpclient"
	"github.com/johnny4young/janusly/internal/store"
	"github.com/johnny4young/janusly/internal/tools"
)

const (
	CatalogSchemaVersion     = "1"
	maxDynamicCatalogEntries = 200
)

// McpCatalogSource is the narrow tenant-safe discovery seam. The concrete MCP
// client already applies four opt-in flags, sanitization and byte/count caps.
type McpCatalogSource interface {
	ListExposedToolsForCatalog(context.Context, string) ([]mcpclient.ExposedMcpTool, error)
}

// TriggerCapability describes an existing trigger surface and the exact node
// configuration needed for a saved workflow to receive it.
type TriggerCapability struct {
	ID             string   `json:"id"`
	NodeType       string   `json:"nodeType,omitempty"`
	RequiredConfig []string `json:"requiredConfig"`
	Endpoint       string   `json:"endpoint,omitempty"`
}

// PrimitiveCapability covers executable node types whose configuration must
// be complete before a proposal can be applied.
type PrimitiveCapability struct {
	NodeType       string   `json:"nodeType"`
	RequiredConfig []string `json:"requiredConfig"`
	Notes          string   `json:"notes"`
}

// CredentialCapability is a name-only credential binding. Secret references,
// metadata and values are intentionally absent from both the SQL query and the
// wire type.
type CredentialCapability struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Kind       string     `json:"kind"`
	Configured bool       `json:"configured"`
	ExpiresAt  *time.Time `json:"expiresAt,omitempty"`
	Expired    bool       `json:"expired"`
	UpdatedAt  time.Time  `json:"updatedAt"`
}

// SubworkflowCapability is an exact saved-workflow binding. latestVersion is
// informational; proposals may bind workflowId only or pin this exact version.
type SubworkflowCapability struct {
	WorkflowID    string `json:"workflowId"`
	Name          string `json:"name"`
	Status        string `json:"status"`
	LatestVersion int32  `json:"latestVersion"`
}

// Catalog is the shared, bounded capability graph. Version is a SHA-256 over
// the complete safe projection, making stale proposals detectable without
// exposing database revision internals.
type Catalog struct {
	SchemaVersion string                     `json:"schemaVersion"`
	Version       string                     `json:"version"`
	BuiltinTools  []tools.CatalogEntry       `json:"builtinTools"`
	McpTools      []mcpclient.ExposedMcpTool `json:"mcpTools"`
	Triggers      []TriggerCapability        `json:"triggers"`
	Credentials   []CredentialCapability     `json:"credentials"`
	Subworkflows  []SubworkflowCapability    `json:"subworkflows"`
	Primitives    []PrimitiveCapability      `json:"primitives"`
	Warnings      []string                   `json:"warnings"`
}

// Builder reads tenant-specific capabilities and joins them with the process
// runtime registry. A dynamic source failure degrades that category to empty
// with a stable warning; built-ins remain usable and no request is blocked.
type Builder struct {
	Pool     *pgxpool.Pool
	MCP      McpCatalogSource
	Registry *tools.Registry
	Now      func() time.Time
}

func NewBuilder(pool *pgxpool.Pool, mcp McpCatalogSource) *Builder {
	return &Builder{Pool: pool, MCP: mcp, Registry: executors.SharedToolRegistry(), Now: time.Now}
}

func (b *Builder) Build(ctx context.Context, orgID string) Catalog {
	registry := b.Registry
	if registry == nil {
		registry = executors.SharedToolRegistry()
	}
	now := time.Now()
	if b.Now != nil {
		now = b.Now()
	}
	catalog := Catalog{
		SchemaVersion: CatalogSchemaVersion,
		BuiltinTools:  registry.CatalogEntries(),
		Triggers:      triggerCapabilities(),
		Primitives:    primitiveCapabilities(),
		McpTools:      []mcpclient.ExposedMcpTool{},
		Credentials:   []CredentialCapability{},
		Subworkflows:  []SubworkflowCapability{},
		Warnings:      []string{},
	}
	if b.MCP != nil {
		tools, err := b.MCP.ListExposedToolsForCatalog(ctx, orgID)
		if err != nil {
			catalog.Warnings = append(catalog.Warnings, "mcp_tools_unavailable")
		} else {
			for index := range tools {
				if tools[index].InputFields == nil {
					tools[index].InputFields = []mcpclient.ExposedMcpInputField{}
				}
			}
			catalog.McpTools = tools
			if slices.ContainsFunc(tools, func(tool mcpclient.ExposedMcpTool) bool {
				return tool.ConnectionAlias == "_truncated" || tool.ToolName == "_truncated"
			}) {
				catalog.Warnings = append(catalog.Warnings, "mcp_tools_truncated")
			}
		}
	}
	if b.Pool != nil {
		q := store.New(b.Pool)
		credentials, err := q.ListAuthoringCredentialCapabilities(ctx, orgID)
		if err != nil {
			catalog.Warnings = append(catalog.Warnings, "credentials_unavailable")
		} else {
			credentials = boundedCatalogRows(credentials, "credentials_truncated", &catalog.Warnings)
			for _, row := range credentials {
				expired := row.ExpiresAt != nil && !row.ExpiresAt.After(now)
				catalog.Credentials = append(catalog.Credentials, CredentialCapability{
					ID: row.ID, Name: row.Name, Kind: row.Kind, Configured: row.Configured,
					ExpiresAt: row.ExpiresAt, Expired: expired, UpdatedAt: row.UpdatedAt,
				})
			}
		}
		workflows, err := q.ListAuthoringSubworkflowCapabilities(ctx, orgID)
		if err != nil {
			catalog.Warnings = append(catalog.Warnings, "subworkflows_unavailable")
		} else {
			workflows = boundedCatalogRows(workflows, "subworkflows_truncated", &catalog.Warnings)
			for _, row := range workflows {
				catalog.Subworkflows = append(catalog.Subworkflows, SubworkflowCapability{
					WorkflowID: row.ID, Name: row.Name, Status: row.Status, LatestVersion: row.LatestVersion,
				})
			}
		}
	}
	catalog.Version = catalogDigest(catalog)
	return catalog
}

func boundedCatalogRows[T any](rows []T, warning string, warnings *[]string) []T {
	if len(rows) <= maxDynamicCatalogEntries {
		return rows
	}
	*warnings = append(*warnings, warning)
	return rows[:maxDynamicCatalogEntries]
}

func catalogDigest(catalog Catalog) string {
	catalog.Version = ""
	raw, err := json.Marshal(catalog)
	if err != nil {
		return strings.Repeat("0", 64)
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func triggerCapabilities() []TriggerCapability {
	return []TriggerCapability{
		{ID: "manual", RequiredConfig: []string{}, Endpoint: "POST /v1/start"},
		{ID: "schedule", NodeType: "schedule", RequiredConfig: []string{"cronExpression"}},
		{ID: "webhook", NodeType: "webhook_received", RequiredConfig: []string{"endpointKey"}, Endpoint: "POST /v1/webhooks/{workflowId}"},
		{ID: "email", NodeType: "email_received", RequiredConfig: []string{"aliasKey"}, Endpoint: "POST /v1/triggers/email/ingest"},
		{ID: "file", NodeType: "file_dropped", RequiredConfig: []string{"bucket"}, Endpoint: "POST /v1/triggers/file/ingest"},
		{ID: "mcp_event", NodeType: "mcp_server_event", RequiredConfig: []string{"connectionAlias", "resourceUri"}, Endpoint: "POST /v1/triggers/mcp/ingest"},
		{ID: "pagerduty", NodeType: "pagerduty_incident", RequiredConfig: []string{"webhookCredential"}, Endpoint: "POST /webhooks/pagerduty/{workflowId}/{nodeId}"},
	}
}

func primitiveCapabilities() []PrimitiveCapability {
	entries := []PrimitiveCapability{
		{NodeType: "wait_until", RequiredConfig: []string{"duration|until"}, Notes: "Exactly one ISO-8601 duration or timezone-qualified instant."},
		{NodeType: "schedule", RequiredConfig: []string{"cronExpression"}, Notes: "Valid five-field cron expression."},
		{NodeType: "multi_agent", RequiredConfig: []string{"agents"}, Notes: "One to 16 agents with explicit goals; sequential or parallel; bounded to 50 steps per member."},
		{NodeType: "router_llm", RequiredConfig: []string{"candidates"}, Notes: "At least two direct-successor candidates."},
		{NodeType: "subworkflow", RequiredConfig: []string{"workflowId"}, Notes: "Exact saved workflow from subworkflows catalog."},
	}
	slices.SortFunc(entries, func(a, b PrimitiveCapability) int { return strings.Compare(a.NodeType, b.NodeType) })
	return entries
}
