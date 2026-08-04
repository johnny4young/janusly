# Platform services

The Janusly executable owns public HTTP, React assets, run streaming, workflow
execution, maintenance, and metrics.

Run streaming is SSE delivered through authenticated `fetch` and
`ReadableStream`. Events are read from durable PostgreSQL state and notification
channels, with bounded reconnect cursors.

The internal listener exposes Prometheus metrics and verified build identity on
`127.0.0.1:9464` by default. Public health returns only safe bounded status.

Rate limits and workflow queue state are PostgreSQL-backed so multiple Janusly
instances share one durable view. A store error keeps the documented fail-open
traffic posture while emitting degradation evidence.
