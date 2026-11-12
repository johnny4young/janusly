// Package agentclient owns external agent credentials and resolves an agent's
// authority: its capability ceiling intersected with its creator's grant.
package agentclient

import (
	"errors"
	"slices"
)

// Capability is one coarse grant an organization gives an agent client.
type Capability string

const (
	CapabilityRead    Capability = "read"
	CapabilityPropose Capability = "propose"
	CapabilityTest    Capability = "test"
	CapabilityPublish Capability = "publish"
	CapabilityOperate Capability = "operate"
	CapabilityReport  Capability = "report"
)

// AllCapabilities lists every capability in display order.
var AllCapabilities = []Capability{
	CapabilityRead, CapabilityPropose, CapabilityTest, CapabilityPublish, CapabilityOperate, CapabilityReport,
}

// capabilityTools is the only path from a capability to an MCP tool. A tool
// missing here is unreachable for every agent client, whatever permissions
// its creator holds.
var capabilityTools = map[Capability][]string{
	CapabilityRead: {
		"agent.info", "catalog.describe",
		"workflows.list", "workflows.get", "workflows.assure", "workflows.validate",
		"runs.list", "runs.status", "runs.inspect", "runs.output",
		"dlq.list", "operations.brief", "recovery.cases.inspect",
		"drafts.get", "drafts.list", "qualifications.get", "publish.status",
	},
	CapabilityPropose: {"drafts.save", "credentials.request", "sessions.to_draft"},
	CapabilityTest:    {"workflows.test", "workflows.qualify"},
	CapabilityPublish: {"workflows.publish"},
	CapabilityOperate: {
		"runs.start", "runs.cancel", "dlq.redrive",
		"workflows.rollback", "workflows.deactivate", "workflows.reactivate",
		"workflows.pause", "workflows.resume",
		"recovery.cases.diagnose", "recovery.cases.validate", "recovery.cases.apply",
	},
	CapabilityReport: {},
}

var capabilityPermissions = map[Capability][]string{
	CapabilityRead:    {"workflows.read", "runs.read", "dlq.read", "recovery.read", "credentials.read"},
	CapabilityPropose: {"workflows.write"},
	CapabilityTest:    {"runs.start"},
	CapabilityPublish: {"workflows.write"},
	CapabilityOperate: {"runs.start", "runs.cancel", "dlq.replay", "workflows.write", "recovery.write"},
	CapabilityReport:  {},
}

// ErrUnknownCapability rejects a ceiling naming anything outside the set.
var ErrUnknownCapability = errors.New("unknown capability")

// ParseCapabilities validates, deduplicates and orders a ceiling. Read is
// implied by every other capability, so it is always present.
func ParseCapabilities(values []string) ([]Capability, error) {
	seen := map[Capability]bool{CapabilityRead: true}
	for _, value := range values {
		capability := Capability(value)
		if _, ok := capabilityTools[capability]; !ok {
			return nil, ErrUnknownCapability
		}
		seen[capability] = true
	}
	out := make([]Capability, 0, len(seen))
	for _, capability := range AllCapabilities {
		if seen[capability] {
			out = append(out, capability)
		}
	}
	return out, nil
}

// CeilingPermissions is the permission set a ceiling may use before it is
// intersected with the creator's grant.
func CeilingPermissions(capabilities []Capability) map[string]bool {
	out := map[string]bool{}
	for _, capability := range capabilities {
		for _, permission := range capabilityPermissions[capability] {
			out[permission] = true
		}
	}
	return out
}

// CeilingTools is the set of MCP tools a ceiling reaches.
func CeilingTools(capabilities []Capability) map[string]bool {
	out := map[string]bool{}
	for _, capability := range capabilities {
		for _, tool := range capabilityTools[capability] {
			out[tool] = true
		}
	}
	return out
}

// Strings renders a ceiling for storage and wire payloads.
func Strings(capabilities []Capability) []string {
	out := make([]string, 0, len(capabilities))
	for _, capability := range capabilities {
		out = append(out, string(capability))
	}
	return out
}

// MissingPermissions names the ceiling permissions a person lacks, so they
// cannot hand an agent more than they hold.
func MissingPermissions(capabilities []Capability, held map[string]bool) []string {
	missing := []string{}
	for permission := range CeilingPermissions(capabilities) {
		if !held[permission] {
			missing = append(missing, permission)
		}
	}
	slices.Sort(missing)
	return missing
}
