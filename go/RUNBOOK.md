# Runbook de operación — binario Go del pilot

Un solo binario (`cmd/api`) sirve el API, los workers, el pump de campañas
de replay, el sweep de retención y el stream SSE. Sin Redis, sin proceso
worker aparte: la cola vive en Postgres.

## Requisitos

- PostgreSQL 15+ (baseline 18; el lane `make test-pg15` prueba el floor).
- El esquema compartido migrado (`make migrate` — aplica drizzle Y la
  migración propia del pilot; ver «Migraciones»).

## Variables de entorno

| Variable | Default | Qué controla |
|---|---|---|
| `JANUSLY_GO_DATABASE_URL` | — (requerida) | DSN de Postgres |
| `JANUSLY_GO_PORT` | 4600 | Puerto del API público |
| `JANUSLY_GO_INTERNAL_PORT` | 4601 | pprof + métricas internas |
| `JANUSLY_GO_WORKER_CONCURRENCY` | 8 | Workers de ejecución de nodos |
| `JANUSLY_GO_POLL_MS` | 500 | Poll del queue (NOTIFY lo adelanta) |
| `JANUSLY_GO_API_POOL_SIZE` | 10 | Pool de conexiones del API |
| `JANUSLY_GO_WORKER_POOL_SIZE` | concurrencia+2 | Pool de los workers |
| `JANUSLY_GO_HTTP_TIMEOUT_MS` | 30000 | Timeout HTTP saliente por defecto |
| `JANUSLY_GO_RETENTION_DELETED_WORKFLOWS_DAYS` | 30 | Fallback global del sweep; desde T-087 la ventana real es por org vía el catálogo (`retention.deletedWorkflowsDays`, env de referencia `JANUSLY_RETENTION_DELETED_WORKFLOWS_DAYS`) |
| `ALLOW_PRIVATE_HTTP_TARGETS` | false | Deshabilita el guard SSRF (solo dev) |
| `JANUSLY_GO_ENV` | — | `production` activa el gate de arranque: sin `SUPABASE_URL` el binario REHÚSA salvo `ALLOW_DEV_AUTH_HEADERS=true` |
| `JANUSLY_QUEUE_LAG_WARN_SECONDS` | 60 | Umbral (1..86400) que marca `degraded` cuando el nodo elegible más viejo espera más que esto |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | — | Modo Supabase de la cadena de auth |
| `JANUSLY_API_SERVICE_TOKEN` | — | Modo service-token (comparación en tiempo constante) |
| `JANUSLY_PRODUCTION_MODE` | — | `true` activa el readiness gate en `/start` |
| `JANUSLY_REQUIRE_EVAL_COVERAGE` | — | `true` añade el warn de evals al gate |
| `JANUSLY_MCP_WRITES_ENABLED` | — | `true` habilita escrituras MCP (más consent por org) |
| `JANUSLY_HTTP_TIMEOUT_MS` / `_MAX_RESPONSE_BYTES` / `_MAX_REDIRECTS` / `_STREAM_PREVIEW_BYTES` | 30000 / 1 MB / 5 / 64 KB | Capa env de los bounds por tenant |

## Construir y correr

```bash
cd go && go build -o /usr/local/bin/janusly-go ./cmd/api
JANUSLY_GO_DATABASE_URL='postgres://…' janusly-go
```

Salud: `GET /healthz` (proceso vivo) — úsalo como health check del
supervisor. El apagado limpio drena los workers: envía `SIGTERM` y espera
(gracia de 10s).

### systemd (Linux)

```ini
[Unit]
Description=Janusly Go pilot
After=network-online.target postgresql.service

[Service]
ExecStart=/usr/local/bin/janusly-go
Environment=JANUSLY_GO_DATABASE_URL=postgres://janusly:…@127.0.0.1:5432/janusly
Restart=on-failure
RestartSec=2
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

### launchd (macOS)

`~/Library/LaunchAgents/com.janusly.gopilot.plist` con `ProgramArguments`
apuntando al binario, `EnvironmentVariables` con el DSN, `KeepAlive` true.
`launchctl load` para instalar; `launchctl unload` detiene con SIGTERM.

## Migraciones

goose (Go puro) es el dueño del esquema del pilot desde 2026-07-31. Las
migraciones viven EMBEBIDAS en el binario:

```bash
janusly-go migrate
```

Eso es todo — sin Node, sin pnpm, sin psql. Una base fresca recibe el
baseline completo (esquema compartido + objetos del pilot); una base
provisionada antes de goose se estampa en el baseline automáticamente sin
re-ejecutarlo. El binario rehúsa servir contra una base des-migrada. La
contabilidad vive en `go_pilot_goose_version` (jamás choca con la de
drizzle). Regla de sincronización: cada sync con develop espeja las
migraciones drizzle nuevas como migraciones goose numeradas.

Nota: una base provisionada por goose NO debe correr `pnpm migrate` del
repo Node (la tabla drizzle existe vacía y drizzle re-ejecutaría todo).

## Copia de seguridad y restauración

Todo el estado vive en Postgres — la copia de la base ES la copia del
sistema:

```bash
pg_dump -Fc -d "$JANUSLY_GO_DATABASE_URL" > janusly-$(date +%F).dump
pg_restore -d "$JANUSLY_GO_DATABASE_URL" --clean --if-exists janusly.dump
```

Tras restaurar en caliente no hace falta nada más: los timers vencidos
durante la ventana los drena el sweep justo (lotes round-robin por run) y
las campañas retoman su due-clock. Los runs que estaban `running` con nodos
huérfanos los recupera el reaper de nodos atascados.

## Actualización (upgrade)

1. `pg_dump` (arriba).
2. Aplica migraciones nuevas (`make migrate` o los SQL a mano).
3. Reemplaza el binario y reinicia el servicio (`systemctl restart`).
   El SIGTERM drena los trabajos en vuelo; los claims con lease que un
   crash dejara a medias los recupera el reaper.
4. Verifica: `GET /healthz`, después `GET /recovery/metrics` y una corrida
   de humo (`POST /start` con un noop).

Rollback del binario = reinstalar el anterior; el esquema es
backward-tolerant dentro de la ola (los objetos del pilot solo se añaden).

## Diagnóstico rápido

| Síntoma | Primer paso |
|---|---|
| Runs en `running` sin avanzar | `SELECT count(*) FROM run_nodes WHERE status='queued'` — si crece, revisa workers en el log; el reaper repone claims muertos |
| Timers que no disparan | ¿existe `go_pilot_wakeups`? (`janusly-go migrate` pendiente = el gap clásico) |
| 403 en tools MCP de escritura | El escalón de consent: env primero, luego la fila `mcp.writeConsent` del org |
| Latencia de lista alta | `ANALYZE runs;` y confirma el índice `go_pilot_runs_org_created_id_idx` |
| Todo 500 | El DSN: el binario no arranca a medias — si responde, la base era alcanzable al boot |
