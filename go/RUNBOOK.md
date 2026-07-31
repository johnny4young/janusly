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
| `JANUSLY_GO_RETENTION_DELETED_WORKFLOWS_DAYS` | 30 | Ventana del sweep de tombstones |
| `ALLOW_PRIVATE_HTTP_TARGETS` | false | Deshabilita el guard SSRF (solo dev) |
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

`make migrate` hace DOS cosas y ambas importan: las migraciones drizzle del
esquema compartido (vía `pnpm migrate` del repo) y después
`migrations/0001_go_pilot.sql` (objetos propios del pilot: wakeups de
timers, idempotencia de start, índice keyset de runs). En un despliegue sin
el repo Node a mano, aplica el SQL de drizzle desde
`packages/db/migrations/` en orden y luego el archivo del pilot con
`psql -v ON_ERROR_STOP=1`. Todo es idempotente (`IF NOT EXISTS`).

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
| Timers que no disparan | ¿existe `go_pilot_wakeups`? (migración del pilot ausente = el gap clásico) |
| 403 en tools MCP de escritura | El escalón de consent: env primero, luego la fila `mcp.writeConsent` del org |
| Latencia de lista alta | `ANALYZE runs;` y confirma el índice `go_pilot_runs_org_created_id_idx` |
| Todo 500 | El DSN: el binario no arranca a medias — si responde, la base era alcanzable al boot |
