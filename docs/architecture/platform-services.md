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

The opt-in weekly operations digest is also multi-replica safe. One leased
`org_digest_state` batch records each successful admin recipient before the
provider call moves on. Partial failures release the lease with backoff and a
later sweep resumes only the remaining recipients; a completed batch is not
eligible again for 167 hours. Custom roles inheriting `admin` are recipients,
and large recipient sets are continued in bounded batches instead of silently
truncated.
