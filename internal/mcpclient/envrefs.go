package mcpclient

import (
	"bytes"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strings"
)

const (
	// MaxEnvRefs bounds both request work and the number of values projected
	// into a child process or outbound HTTP headers.
	MaxEnvRefs = 64
	// MaxEnvRefsJSONBytes prevents a damaged JSONB row from turning every
	// readiness or execution check into an unbounded decode.
	MaxEnvRefsJSONBytes = 64 * 1024
)

var (
	ErrEnvRefsInvalid = errors.New("mcp_env_refs_invalid")
	envRefKeyPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
	envRefNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)
)

// EnvRef is the only durable MCP secret-reference shape. The value remains a
// deployment-owned environment-variable name; secret material never enters
// this document.
type EnvRef struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

// ParseEnvRefs decodes the closed MCP env_refs JSONB contract. Empty bytes and
// the historical JSON null representation both mean no references. Every
// other malformed entry fails closed instead of disappearing from readiness
// and execution projections.
func ParseEnvRefs(raw []byte) (map[string]EnvRef, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return map[string]EnvRef{}, nil
	}
	if len(trimmed) > MaxEnvRefsJSONBytes {
		return nil, ErrEnvRefsInvalid
	}
	var encoded map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &encoded); err != nil || encoded == nil || len(encoded) > MaxEnvRefs {
		return nil, ErrEnvRefsInvalid
	}
	keys := make([]string, 0, len(encoded))
	for key := range encoded {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	refs := make(map[string]EnvRef, len(encoded))
	for _, key := range keys {
		if !envRefKeyPattern.MatchString(key) {
			return nil, ErrEnvRefsInvalid
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(encoded[key], &fields); err != nil || len(fields) != 2 {
			return nil, ErrEnvRefsInvalid
		}
		var kind, name string
		if err := json.Unmarshal(fields["kind"], &kind); err != nil || kind != "env" {
			return nil, ErrEnvRefsInvalid
		}
		if err := json.Unmarshal(fields["name"], &name); err != nil {
			return nil, ErrEnvRefsInvalid
		}
		name = strings.TrimSpace(name)
		if !envRefNamePattern.MatchString(name) {
			return nil, ErrEnvRefsInvalid
		}
		refs[key] = EnvRef{Kind: "env", Name: name}
	}
	return refs, nil
}
