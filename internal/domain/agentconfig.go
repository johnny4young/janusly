package domain

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

const (
	// AgentDefaultMaxSteps is the single-agent default used by the runtime.
	AgentDefaultMaxSteps = 3
	// MultiAgentDefaultMaxSteps is the per-member default used by a crew.
	MultiAgentDefaultMaxSteps = 2
	// AgentMaxSteps bounds both standalone agents and crew members.
	AgentMaxSteps = 50
	// AgentMaxTimeoutMS prevents an authored agent tool call from holding a
	// worker indefinitely.
	AgentMaxTimeoutMS = 600_000
	// MultiAgentMaxAgents bounds fan-out, event volume, and provider calls.
	MultiAgentMaxAgents = 16
)

// AgentConfigErrorKind lets workflow validation translate one shared config
// grammar into stable wire codes without making executors parse error strings.
type AgentConfigErrorKind string

const (
	AgentConfigInvalidPlanner     AgentConfigErrorKind = "agent_invalid_planner"
	AgentConfigInvalidMaxSteps    AgentConfigErrorKind = "agent_invalid_max_steps"
	AgentConfigInvalidTimeout     AgentConfigErrorKind = "agent_invalid_timeout"
	AgentConfigInvalidBoolean     AgentConfigErrorKind = "agent_invalid_boolean"
	AgentConfigInvalidField       AgentConfigErrorKind = "agent_invalid_config"
	MultiAgentConfigMissingAgents AgentConfigErrorKind = "multi_agent_missing_agents"
	MultiAgentConfigInvalidAgents AgentConfigErrorKind = "multi_agent_invalid_agents"
	MultiAgentConfigInvalidMode   AgentConfigErrorKind = "multi_agent_invalid_mode"
	MultiAgentConfigInvalidAgg    AgentConfigErrorKind = "multi_agent_invalid_aggregation"
	MultiAgentConfigInvalidBool   AgentConfigErrorKind = "multi_agent_invalid_boolean"
)

// AgentConfigError is returned by both save-time validation and execution.
// Keeping the message here makes the two boundaries reject the same shapes.
type AgentConfigError struct {
	Kind    AgentConfigErrorKind
	Message string
}

func (e *AgentConfigError) Error() string { return e.Message }

// AgentRuntimeConfig is the normalized subset read by runAgentLoop.
type AgentRuntimeConfig struct {
	Planner     string
	MaxSteps    int
	TimeoutMS   int
	HasTimeout  bool
	Reflection  bool
	AllowWrites bool
}

// MultiAgentRuntimeConfig is the normalized crew envelope. Member settings
// remain on the member objects because the executor applies node-level
// defaults after late-bound goal rendering.
type MultiAgentRuntimeConfig struct {
	Agents          []any
	Mode            string
	Aggregation     string
	ContinueOnError bool
}

// ResolveAgentRuntimeConfig validates and normalizes every scalar field the
// agent runtime reads. defaultMaxSteps/defaultReflection distinguish a
// standalone agent from a crew member while preserving one grammar.
func ResolveAgentRuntimeConfig(config map[string]any, defaultMaxSteps int, defaultReflection bool) (AgentRuntimeConfig, error) {
	if config == nil {
		config = map[string]any{}
	}
	planner := "rules"
	if raw, present := config["planner"]; present {
		value, ok := raw.(string)
		if !ok || (value != "" && value != "rules" && value != "ai") {
			return AgentRuntimeConfig{}, &AgentConfigError{
				Kind: AgentConfigInvalidPlanner, Message: "agent planner must be rules or ai",
			}
		}
		if value != "" {
			planner = value
		}
	}

	maxSteps := defaultMaxSteps
	if raw, present := config["maxSteps"]; present {
		value, ok := boundedAgentInteger(raw, 1, AgentMaxSteps)
		if !ok {
			return AgentRuntimeConfig{}, &AgentConfigError{
				Kind:    AgentConfigInvalidMaxSteps,
				Message: fmt.Sprintf("agent maxSteps must be an integer between 1 and %d", AgentMaxSteps),
			}
		}
		maxSteps = value
	}

	timeoutMS, hasTimeout := 0, false
	if raw, present := config["timeoutMs"]; present {
		value, ok := boundedAgentInteger(raw, 1, AgentMaxTimeoutMS)
		if !ok {
			return AgentRuntimeConfig{}, &AgentConfigError{
				Kind:    AgentConfigInvalidTimeout,
				Message: fmt.Sprintf("agent timeoutMs must be an integer between 1 and %d", AgentMaxTimeoutMS),
			}
		}
		timeoutMS, hasTimeout = value, true
	}

	reflection, err := optionalAgentBool(config, "reflection", defaultReflection)
	if err != nil {
		return AgentRuntimeConfig{}, err
	}
	allowWrites, err := optionalAgentBool(config, "allowWriteTools", false)
	if err != nil {
		return AgentRuntimeConfig{}, err
	}

	for _, field := range []string{"name", "role", "persona", "tool", "value", "text", "path", "url", "method", "model"} {
		if raw, present := config[field]; present && raw != nil {
			if _, ok := raw.(string); !ok {
				return AgentRuntimeConfig{}, &AgentConfigError{
					Kind:    AgentConfigInvalidField,
					Message: fmt.Sprintf("agent %s must be a string", field),
				}
			}
		}
	}
	if _, _, err := ResolvePromptReference(config, "systemPromptRef"); err != nil {
		return AgentRuntimeConfig{}, &AgentConfigError{
			Kind: AgentConfigInvalidField, Message: "agent " + err.Error(),
		}
	}
	if _, err := ResolvePromptVariables(config); err != nil {
		return AgentRuntimeConfig{}, &AgentConfigError{
			Kind: AgentConfigInvalidField, Message: "agent " + err.Error(),
		}
	}

	return AgentRuntimeConfig{
		Planner: planner, MaxSteps: maxSteps,
		TimeoutMS: timeoutMS, HasTimeout: hasTimeout,
		Reflection: reflection, AllowWrites: allowWrites,
	}, nil
}

// ResolveMultiAgentRuntimeConfig validates the complete crew before any
// member starts. This prevents a malformed later member from being discovered
// only after an earlier member has already called a tool.
func ResolveMultiAgentRuntimeConfig(config map[string]any) (MultiAgentRuntimeConfig, error) {
	if config == nil {
		config = map[string]any{}
	}
	agents, valid := config["agents"].([]any)
	if !valid || len(agents) == 0 {
		return MultiAgentRuntimeConfig{}, &AgentConfigError{
			Kind:    MultiAgentConfigMissingAgents,
			Message: "multi_agent requires at least one agent",
		}
	}
	if len(agents) > MultiAgentMaxAgents {
		return MultiAgentRuntimeConfig{}, &AgentConfigError{
			Kind:    MultiAgentConfigInvalidAgents,
			Message: fmt.Sprintf("multi_agent supports at most %d agents", MultiAgentMaxAgents),
		}
	}

	mode := "sequential"
	if raw, present := config["mode"]; present {
		value, ok := raw.(string)
		if !ok || (value != "" && value != "sequential" && value != "parallel") {
			return MultiAgentRuntimeConfig{}, &AgentConfigError{
				Kind:    MultiAgentConfigInvalidMode,
				Message: "multi_agent mode must be sequential or parallel",
			}
		}
		if value != "" {
			mode = value
		}
	}

	aggregation := "last"
	if raw, present := config["aggregation"]; present {
		value, ok := raw.(string)
		if !ok || (value != "" && value != "last" && value != "first" && value != "all" && value != "best-effort") {
			return MultiAgentRuntimeConfig{}, &AgentConfigError{
				Kind:    MultiAgentConfigInvalidAgg,
				Message: "multi_agent aggregation must be last, first, all, or best-effort",
			}
		}
		if value != "" {
			aggregation = value
		}
	}

	continueOnError, err := optionalAgentBool(config, "continueOnError", false)
	if err != nil {
		return MultiAgentRuntimeConfig{}, &AgentConfigError{
			Kind:    MultiAgentConfigInvalidBool,
			Message: "multi_agent continueOnError must be a boolean",
		}
	}

	// Validate inherited settings even when every member overrides them: the
	// node-level contract must remain unambiguous and round-trippable.
	if _, err := ResolveAgentRuntimeConfig(config, MultiAgentDefaultMaxSteps, true); err != nil {
		return MultiAgentRuntimeConfig{}, err
	}
	for index, raw := range agents {
		member, ok := raw.(map[string]any)
		if !ok || member == nil {
			return MultiAgentRuntimeConfig{}, &AgentConfigError{
				Kind:    MultiAgentConfigInvalidAgents,
				Message: fmt.Sprintf("multi_agent agent at index %d must be an object", index),
			}
		}
		if _, err := ResolveAgentRuntimeConfig(member, MultiAgentDefaultMaxSteps, true); err != nil {
			return MultiAgentRuntimeConfig{}, &AgentConfigError{
				Kind:    MultiAgentConfigInvalidAgents,
				Message: fmt.Sprintf("multi_agent agent at index %d is invalid: %s", index, err),
			}
		}
		goal, ok := member["goal"].(string)
		if !ok || strings.TrimSpace(goal) == "" {
			return MultiAgentRuntimeConfig{}, &AgentConfigError{
				Kind:    MultiAgentConfigInvalidAgents,
				Message: fmt.Sprintf("multi_agent agent at index %d requires a non-empty goal", index),
			}
		}
	}

	return MultiAgentRuntimeConfig{
		Agents: agents, Mode: mode, Aggregation: aggregation,
		ContinueOnError: continueOnError,
	}, nil
}

func optionalAgentBool(config map[string]any, field string, fallback bool) (bool, error) {
	raw, present := config[field]
	if !present {
		return fallback, nil
	}
	value, ok := raw.(bool)
	if !ok {
		return false, &AgentConfigError{
			Kind:    AgentConfigInvalidBoolean,
			Message: fmt.Sprintf("agent %s must be a boolean", field),
		}
	}
	return value, nil
}

func boundedAgentInteger(raw any, minimum, maximum int) (int, bool) {
	var value float64
	switch number := raw.(type) {
	case float64:
		value = number
	case float32:
		value = float64(number)
	case int:
		value = float64(number)
	case int8:
		value = float64(number)
	case int16:
		value = float64(number)
	case int32:
		value = float64(number)
	case int64:
		value = float64(number)
	case uint:
		value = float64(number)
	case uint8:
		value = float64(number)
	case uint16:
		value = float64(number)
	case uint32:
		value = float64(number)
	case uint64:
		value = float64(number)
	case json.Number:
		parsed, err := number.Float64()
		if err != nil {
			return 0, false
		}
		value = parsed
	default:
		return 0, false
	}
	if math.IsNaN(value) || math.IsInf(value, 0) || math.Trunc(value) != value ||
		value < float64(minimum) || value > float64(maximum) {
		return 0, false
	}
	return int(value), true
}

// AgentConfiguredTool returns one explicit agent tool and its authored input.
// Empty tool names mean the planner owns selection. A present input must be an
// object because the runtime cannot safely reinterpret scalar JSON as fields.
func AgentConfiguredTool(config map[string]any) (string, map[string]any, error) {
	rawTool, present := config["tool"]
	if !present || rawTool == nil {
		return "", nil, nil
	}
	tool, ok := rawTool.(string)
	if !ok {
		return "", nil, &AgentConfigError{Kind: AgentConfigInvalidField, Message: "agent tool must be a string"}
	}
	tool = strings.TrimSpace(tool)
	if tool == "" {
		return "", nil, nil
	}
	input := map[string]any{}
	if rawInput, present := config["input"]; present && rawInput != nil {
		var valid bool
		input, valid = rawInput.(map[string]any)
		if !valid {
			return "", nil, &AgentConfigError{Kind: AgentConfigInvalidField, Message: "agent input must be an object"}
		}
	}
	return tool, input, nil
}
