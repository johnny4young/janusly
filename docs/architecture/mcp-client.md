# MCP client

`internal/mcpclient` lets workflow tasks consume external MCP tools over stdio,
Streamable HTTP, or SSE.

Network transports use the shared outbound HTTP policy on every request and
redirect. Stdio uses an operator command allowlist, bounded environment,
lifetime, stderr, working directory, and platform resource limits.

Discovery results are validated and bounded before storage. Tool input and
output pass schema checks. A write-capable tool requires process consent,
tenant consent, and a non-validation run.
