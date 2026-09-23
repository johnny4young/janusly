# Local and self-hosted deployment

## Development

Install frontend dependencies once, start PostgreSQL 18, apply the baseline,
and run both development processes:

```bash
make frontend-install
make db-up
make migrate
make dev
```

- React development URL: <http://127.0.0.1:5173>
- Go public URL: <http://127.0.0.1:3001>
- internal metrics: <http://127.0.0.1:9464/metrics>
- PostgreSQL from the host: `127.0.0.1:15473` (loopback only)

Vite proxies API traffic to the Go listener. The production build does not use
that proxy because the same Go process serves both surfaces.

### Database port isolation

The nonstandard host port avoids sharing PostgreSQL's default `5432` with
other local projects. The container still listens on `5432`; the Janusly
container connects to `postgres:5432`, not the host's published port.

To override the host port, export `JANUSLY_POSTGRES_HOST_PORT` in your shell or
pass it to Make consistently:

```bash
make dev JANUSLY_POSTGRES_HOST_PORT=15474
```

Make exports that value to Compose and derives `DB_URL` from it for the API,
migrations and integration tests. An explicit `DB_URL` still takes precedence.
For direct binary execution with a custom port, set `JANUSLY_DATABASE_URL`.
Make's exported host port takes precedence over Compose's `.env` value; do not
change only the Compose `.env` port when using Make.

Changing a port recreates the database container but retains its named volume.
It does not require `db-reset` and must not remove existing data. If the chosen
port is occupied, select another override instead of stopping another project.

## Container deployment

The root `Dockerfile` has three responsibilities:

1. install and compile `/web`;
2. copy the generated bundle into `internal/webdist/dist` inside the build
   container and compile a CGO-disabled Go executable;
3. copy only `janusly` into a non-root minimal image.

Build provenance is injected with exact 40-character Git commit and tree IDs.
The build refuses a dirty checkout so those labels cannot misrepresent local
changes as the current commit.

```bash
make build
```

For the root Compose project:

```bash
docker compose up -d --wait postgres
docker compose run --rm janusly migrate
docker compose up -d janusly
```

The migration command is intentionally explicit. A serving process refuses to
start on an empty or incomplete schema.

For the locally qualified Railway shape, cost model, environment contract, and
remaining online gates, see [Railway deployment and cost qualification](railway.md).

## Fresh databases only

Janusly supports PostgreSQL 18 and one baseline migration. Do not point the
runtime at a database created by a different schema generation. For disposable
local data:

```bash
make db-reset CONFIRM=reset
make db-up
make migrate
```

The reset target scopes deletion to the configured Compose project. It must not
be adapted to delete unrelated volumes or containers.

## Local PostgreSQL backup and restore

The local recovery helper creates a PostgreSQL custom-format backup plus a
manifest containing its checksum, PostgreSQL major, migration/source
fingerprints, Git provenance, and (when managed credentials exist) only a
one-way fingerprint of the high-entropy credential root key. It never records
the key itself; the manifest and dump must still be protected as sensitive.

```bash
export JANUSLY_CREDENTIAL_MASTER_KEY='the-key-used-by-this-stack'
make backup-local OUTPUT=output/backups/before-maintenance
```

A restore is intentionally fail-closed: the Janusly service must be stopped,
the target must be an empty PostgreSQL 18 database, the checkout must match the
schema fingerprint, the dump checksum must pass, and the credential key must
match. The explicit confirmation guard is required.

```bash
docker compose stop janusly
# Start a new empty PostgreSQL 18 target before restoring.
make restore-local INPUT=output/backups/before-maintenance CONFIRM=restore
docker compose run --rm janusly migrate
docker compose up -d janusly
```

This package covers the Janusly application database. Supabase identities and
the credential root key are separate operator-owned systems and require their
own provider backup and escrow procedures. Protect the backup directory as
sensitive data even though managed credential values remain encrypted.

### Isolated local recovery drill

Run the negative guard selftests, then the opt-in positive drill from a checkout
with Docker, Go, `jq`, `make`, and Python 3:

```bash
make recovery-local-selftest
make recovery-local-drill CONFIRM=drill
```

The drill creates two uniquely named, disposable Compose projects. It migrates
the source PostgreSQL 18 database twice, writes one non-secret organization
sentinel, backs it up through the same operator helper, and restores into a
separate **empty** PostgreSQL 18 database. It verifies the migration version
and sentinel, proves a second restore is rejected because the target is no
longer empty, then runs the migration command against the restored target as a
no-op compatibility check. It removes only those two owned projects, their
volumes, and its temporary dump, including on failure. Existing projects are
refused rather than reused or removed.

The JSON result reports the local backup, restore-helper, and target-recovery
durations in milliseconds. `targetRecovery` spans target startup through the
post-restore migration check; it does **not** include detection, operator
decision, provider identity restoration, credential-key retrieval, traffic
switching, or application reconnection. These measurements are not an RTO or
RPO promise. Operators must agree targets and separately drill all recovery
domains before claiming production readiness.

### Binary, snapshot, and schema compatibility

The migration policy is **one fresh PostgreSQL 18 baseline**, not incremental
upgrades of existing databases. `schema.sql` is generated evidence, not an
upgrade script. A backup manifest records the PostgreSQL major, migration
version, dump checksum, and SHA-256 of the embedded migration SQL source. The
restore helper checks the major, dump checksum, schema-source hash and any
required credential-key fingerprint before restoring, then compares the
restored migration version with the manifest. Its Git commit/tree fields are
provenance, **not** a compatibility override.

| Database or snapshot | Candidate binary | Supported operator action |
| --- | --- | --- |
| Empty PostgreSQL 18 database | Verified binary built from the current baseline | Apply `janusly migrate`; qualify readiness and a controlled workflow. |
| PostgreSQL 18 custom dump with matching migration-source SHA-256 and migration version | Same previously qualified binary | Restore to a **new empty** PostgreSQL 18 target, run migration as a no-op, then qualify before traffic cutover. |
| Matching migration-source SHA-256 but a different commit/tree | New or previous verified binary | The helper permits a local restore, but hash equality alone does not prove application compatibility. Qualify that exact image against a restored isolated copy before cutover or rollback. |
| Different migration-source SHA-256 or migration version | Any binary | **Unsupported against the existing database.** No automatic upgrade/downgrade bridge exists; do not run a new baseline over persisted data. Decide an explicit data migration or replace from a compatible snapshot with the owner. |
| Non-PostgreSQL-18 database, nonempty target, invalid dump checksum, or mismatched credential key | Any binary | Restore is refused. Preserve the source and investigate; never use `db-reset` as recovery. |

For an incident, record the last known-good image digest and verified
commit/tree, the backup manifest and timestamp, credential-key escrow owner,
Supabase identity recovery owner, and the application's measured business
impact. Stop new traffic using the platform's approved control and allow the
Janusly process to drain on SIGTERM before replacing it; do not discard the
original database or its durable queue. Restore into a new isolated target,
check the manifest and key through the helper, run the migration command as a
no-op, and verify `/readyz`, the private metrics path, a tenant-scoped read,
and one controlled workflow before a separately approved traffic switch.
If that qualification fails, preserve the original database and do not route
traffic to the failed target; escalate if the original is also unavailable.
Do not try to restore over the now-nonempty target. A binary-only rollback is
valid only with the same qualified schema/snapshot boundary.

The operator must define RPO and RTO for **all three recovery domains**
(application database, Supabase identities, credential root key), name the
incident owner and backup retention, and measure a complete platform drill.
The repository's local drill reports only its explicitly named phases; it
cannot certify provider backup freshness, traffic switching or production
reconnection time.

## Production checklist

The root Compose file has local passwords, development defaults, and loopback
port mappings. It is **not** a production deployment recipe; use a qualified
immutable image and the platform-specific network/secret controls instead.

1. Build from a clean checkout; verify the executable's exact Git commit/tree
   provenance and the immutable OCI image digest. Do not substitute placeholder
   build arguments or treat an unsigned local SBOM as a signed release.
2. Set `JANUSLY_ENV=production`. Use PostgreSQL 18 with the compatible
   baseline/snapshot row above; migrate a fresh database before serving.
3. Configure production Supabase authentication and its browser public values;
   omit `ALLOW_DEV_AUTH_HEADERS` and `ALLOW_DEV_SSO_BYPASS` for an online
   service. The explicit dev-header escape hatch exists for isolated tests,
   not for a public production deployment.
4. Set high-entropy `JANUSLY_RESUME_TOKEN_SECRET`; escrow
   `JANUSLY_CREDENTIAL_MASTER_KEY` before storing managed credentials. Keep
   service-role and provider secrets runtime-only, never in image build args.
5. Terminate TLS in front of public port `3001`, set `JANUSLY_WEB_BASE_URL`
   and `API_ALLOWED_ORIGINS` to the final HTTPS origin. Keep `9464` (metrics,
   build identity, pprof) on a private collector network with no public domain.
6. Run as the image's built-in non-root user. Configure readiness with
   `/readyz`, not only process liveness `/healthz`; retain a termination grace
   period long enough for the supervised workers and accepted optional tasks
   to drain before closing PostgreSQL pools.
7. Arrange provider-grade backups and tested restoration for PostgreSQL,
   Supabase identity and the credential root key. Agree RPO/RTO and perform an
   isolated complete-platform drill before claiming recoverability.
8. Qualify `/healthz`, `/readyz`, `/health`, the React shell, auth, private
   metrics and a controlled workflow on the exact image before traffic cutover.

## Optional embeddings

Ollama is available through the `embeddings` Compose profile:

```bash
docker compose --profile embeddings up -d ollama
```

Enabling the service alone does not enable tenant memory. Both the process gate
and the tenant memory configuration must allow it.

## Artifact build

```bash
make frontend-build
make artifact
./artifacts/janusly provenance
```

The artifact builder requires a clean Git tree. It stages committed source and
the generated web bundle in a temporary directory, writes `janusly` plus
`manifest.json`, and leaves the worktree unchanged.

## Supply-chain evidence

Build the production image and its local evidence bundle from a clean checkout:

```bash
make supply-chain IMAGE=janusly:supply-chain
```

The target fixes BuildKit's SBOM scanner and the standalone Syft generator by
digest, requests `mode=max` BuildKit provenance, and writes a Docker image
archive, BuildKit metadata, image inspection, runtime provenance, an SPDX 2.3
JSON SBOM, a summary, and `SHA256SUMS` under
`artifacts/supply-chain/`. It verifies the current commit/tree, the non-root
runtime user, OCI labels, provenance materials, and a non-empty SBOM before
publishing the directory.

This evidence is **not signed** and the target does not push or publish the
image. Signing and registry attestations remain an explicit release operation.
Base/runtime images and CI Actions are pinned by digest or commit; updates are
reviewed changes rather than mutable tag resolution at qualification time.
