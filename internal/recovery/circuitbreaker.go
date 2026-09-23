// Recovery circuit breaker — the PURE decision layer, implements the
// contract's core/circuit-breaker.ts. While an operator authors a patch,
// a broken workflow keeps re-executing the same doomed DAG on every tick
// and trigger, flooding the DLQ and re-firing pre-failure write-side
// effects. N CONSECUTIVE failed ordinary runs draw the line: the workflow
// pauses and the operator patches a quiet system. Any success resets the
// streak; sandbox replays never count; nothing auto-resumes a tripped
// breaker (no signal is authoritative about "the bug is gone").
package recovery

import "os"

// CircuitBreakerEnv is the process kill switch. Default: ENABLED.
const CircuitBreakerEnv = "JANUSLY_CIRCUIT_BREAKER_ENABLED"

// DefaultCircuitBreakerThreshold applies when neither the workflow nor
// the org declares one. Five is conservative: a genuinely broken workflow
// reaches it in seconds; a flaky-but-working one rarely strings five.
const DefaultCircuitBreakerThreshold = 5

// WorkflowStatusPausedCircuitBreaker is the pause substrate value.
const WorkflowStatusPausedCircuitBreaker = "paused_circuit_breaker"

// IsCircuitBreakerEnabled reports the env kill switch (default on).
func IsCircuitBreakerEnabled() bool {
	return os.Getenv(CircuitBreakerEnv) != "false"
}

// ShouldTripCircuitBreaker: the just-persisted failure trips only when an
// ACTIVE workflow's consecutive-failure streak reaches the threshold.
func ShouldTripCircuitBreaker(consecutiveFailures, threshold int, workflowStatus string) bool {
	if threshold <= 0 {
		return false
	}
	if workflowStatus != "active" {
		return false // already paused / tombstoned
	}
	return consecutiveFailures >= threshold
}
