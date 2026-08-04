# AI-native workflow design

AI assists operators at three layers: workflow authoring, workflow execution,
and recovery explanation. These layers share configuration and telemetry but
have separate authority boundaries.

Authoring returns validated drafts and never saves without an explicit API
mutation. Execution runs inside a bounded workflow task and uses the same
retry, timeout, persistence, and cancellation contracts as other tasks.
Recovery can propose one or more patches, but the operator and deterministic
recovery policy decide whether a patch is applied or replayed.

Every layer preserves a fallback result when completion service is unavailable.
