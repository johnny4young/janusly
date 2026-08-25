# Railway deployment and cost qualification

> Status as of 2026-08-24: **locally qualified, not deployed to Railway**.
> The repository can prove the production OCI image and keyless runtime on an
> isolated machine. Only a real Railway pilot can prove platform networking,
> measured usage, provider backups, and an online business margin.

## Recommended deployment shape

Use one prebuilt, environment-specific Janusly OCI image plus one private
PostgreSQL 18 service:

```text
Internet -> Railway TLS/domain -> Janusly :3001 -> private DATABASE_URL -> PostgreSQL 18
                                      |
                                      +-> Supabase Auth (external)
                                      +-> Anthropic (optional)
```

Janusly intentionally ships one process for the API, React assets, workers,
scheduler, and maintenance loops. Keep Railway Serverless disabled: sleeping
the service would also stop workflow processing and scheduling.

### Why a prebuilt OCI image

Production boot requires the exact 40-character Git commit **and Git tree** in
the executable. Railway source builds expose `RAILWAY_GIT_COMMIT_SHA`, but do
not expose the tree ID. Do not weaken the runtime gate and do not copy the
commit into the tree field. Build the image from a clean checkout with:

```bash
make build IMAGE=registry.example/janusly:<immutable-tag>
docker run --rm registry.example/janusly:<immutable-tag> provenance
```

The image also embeds Vite's public Supabase URL/publishable key at build time,
so build one image for the intended environment. Never put service-role or
Anthropic secrets in Docker build arguments.

Before publishing, the local qualification is:

```bash
make qualify-oci-local CONFIRM=reset IMAGE=janusly:qualification
```

It refuses a dirty source tree, builds the OCI image, checks its non-root user,
entrypoint, OCI labels, image-size budget and executable provenance, starts an
isolated PostgreSQL 18 stack in production mode, migrates it, checks health and
the React shell, and proves the deterministic no-Anthropic fallback in the API
and real Chromium. It does **not** push or deploy anything.

## Railway service configuration

1. Create a Railway project on Trial/Hobby for the measured pilot.
2. Add a PostgreSQL service pinned to major 18. Railway database templates are
   operator-managed services, not a promise of managed backups or PITR.
3. Attach a persistent volume to PostgreSQL and verify its mount and capacity.
4. Deploy the immutable OCI image to a Janusly service.
5. Reference the database's private `DATABASE_URL`; do not use
   `DATABASE_PUBLIC_URL` for service-to-service traffic.
6. Configure `/healthz` as the healthcheck path.
7. Configure `/janusly migrate` as the pre-deploy command.
8. Set both `PORT=3001` and `JANUSLY_PORT=3001`. Janusly deliberately does not
   treat platform-specific `PORT` as an application configuration alias.
9. Keep internal metrics port `9464` private. Expose only the public service.
10. Keep Serverless off and start with one replica. Multiple replicas require a
    separate online qualification of scheduler/worker behavior and capacity.

Required production variables include:

| Variable | Rule |
|---|---|
| `JANUSLY_ENV` | Exactly `production` |
| `JANUSLY_DATABASE_URL` | Reference the private PostgreSQL `DATABASE_URL` |
| `PORT`, `JANUSLY_PORT` | Both `3001` |
| `JANUSLY_RESUME_TOKEN_SECRET` | High-entropy Railway secret |
| `JANUSLY_CREDENTIAL_MASTER_KEY` | High-entropy secret with offline escrow if managed credentials are used |
| `SUPABASE_URL` | Production Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret; runtime only |
| `ANTHROPIC_API_KEY` | Optional secret; runtime only |
| `JANUSLY_WEB_BASE_URL` | Final HTTPS origin |
| `API_ALLOWED_ORIGINS` | Final HTTPS origin only |
| `ALLOW_DEV_AUTH_HEADERS` | Omit or `false` online |

Build-time public values are `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`, and optionally `VITE_DOCS_URL`.

## Current Railway cost model

The following is a planning snapshot, not a quote. Verify it before spending:

| Item | Public price |
|---|---:|
| Free plan | USD 0/month, USD 1 monthly usage credit |
| Hobby plan | USD 5/month minimum, including USD 5 of usage |
| Pro plan | USD 20/month minimum, including USD 20 of usage |
| RAM | USD 10 per GB-month |
| CPU | USD 20 per vCPU-month |
| Egress | USD 0.05 per GB |
| Volume | USD 0.15 per GB-month |

Authoritative references: [plans](https://docs.railway.com/pricing/plans),
[pricing FAQ](https://docs.railway.com/pricing/faqs), and
[cost control](https://docs.railway.com/pricing/cost-control).

For a full month, estimate resource usage as:

```text
railway_usage = RAM_GB * 10
              + average_vCPU * 20
              + egress_GB * 0.05
              + volume_GB * 0.15

railway_bill = max(plan_minimum, railway_usage)
```

Do not size from limits. Size from measured average consumption. Local load
evidence measured the Janusly process, but it is not a Railway quote and does
not include the provider's PostgreSQL footprint or public egress.

### Illustrative pilot scenarios

These examples are arithmetic assumptions, not observed Railway bills:

| Scenario | App | PostgreSQL | Egress | Volume | Resource estimate | Plan bill |
|---|---:|---:|---:|---:|---:|---:|
| Small pilot | 0.5 GB + 0.10 vCPU | 1 GB + 0.10 vCPU | 10 GB | 5 GB | USD 20.25 | about USD 20.25 |
| Active beta | 1 GB + 0.25 vCPU | 2 GB + 0.25 vCPU | 50 GB | 20 GB | USD 45.50 | about USD 45.50 |
| Pro baseline | 2 GB + 0.50 vCPU | 4 GB + 0.50 vCPU | 100 GB | 50 GB | USD 92.50 | about USD 92.50 |

Recalculate with the average CPU and RAM shown in Railway rather than the
configured ceilings. A sensible *ceiling* for the first measured pilot is an
app at 1 vCPU/512 MB and PostgreSQL at 1 vCPU/1 GB, but those are safety bounds,
not predicted utilization.

## Where to see and control spend

- Railway dashboard: **Workspace -> Usage** shows current and estimated usage.
- Each service's metrics show CPU, RAM, network, and volume trends.
- Set a custom email alert and a workspace hard limit before the pilot.
- CLI, once installed and authenticated:

```bash
railway usage limit status
railway usage limit set --target workspace --soft 75 --hard 125
```

A hard limit controls downside by taking workloads offline. That may be right
for a private pilot, but it is not a high-availability policy. The official
recommendation is to deploy on Trial/Hobby, run for one representative week,
read **Estimated Usage** in Workspace Usage, and extrapolate only after the
traffic mix is representative.

## Profitability worksheet

Railway is only one part of cost of goods sold:

```text
monthly_contribution = paying_customers * price_per_customer
                     - Railway
                     - Anthropic
                     - Supabase
                     - email/payment/observability/support variable costs

break_even_customers = ceil(
  monthly_fixed_costs / (price_per_customer - variable_cost_per_customer)
)
```

Track Anthropic usage per organization from Janusly's AI usage surfaces and
enforce tenant budgets. Compare gross margin both with and without AI because
Janusly remains functional in deterministic fallback mode without an API key.

For example, with an assumed USD 49 price, USD 12 variable cost per customer,
and USD 45.50 fixed platform cost, break-even is `ceil(45.50 / 37) = 2`
customers. This is only a model: replace every input with the one-week pilot
and billing data before making a pricing decision.

## Stop/go evidence for an online pilot

Do not call the product online-qualified until all of these are recorded:

- immutable pushed image digest matches the locally qualified image;
- Railway environment uses PostgreSQL 18 and private networking;
- migration, `/healthz`, `/health`, login, Owner/admin delegation, workflow
  authoring, execution, approval, and no-key fallback pass on the public URL;
- a controlled Anthropic workflow passes with a tenant budget;
- Railway hard-limit behavior and alert delivery are exercised;
- PostgreSQL and Supabase backup/PITR responsibilities are configured and an
  isolated restore is tested;
- one representative week of Workspace Usage is exported and used for the
  margin calculation.

No repository command in this document deploys, pushes, or mutates Railway.

Additional official references:
[healthchecks](https://docs.railway.com/deployments/healthchecks),
[pre-deploy command](https://docs.railway.com/deployments/pre-deploy-command),
[PostgreSQL](https://docs.railway.com/databases/postgresql), and
[variables](https://docs.railway.com/variables/reference).
