# Runbook de cutover por tenant — Node → Go

Complementa `CUTOVER-MAP.md` (QUÉ familia migra y cuándo); este runbook
es el CÓMO de un switch por tenant, su monitoreo y su rollback.

## Pre-requisitos (una vez por entorno)

1. `make dual` verde en el entorno (27/27 fuera de la lista anotada).
2. Go desplegado junto a Node contra el MISMO Postgres/Redis, con:
   - `JANUSLY_API_SERVICE_TOKEN` (los SDKs lo usan; probado por la lane
     `run-sdk-live.mjs`), secreto de resume tokens, secretos de webhooks.
   - Pools acotados al presupuesto real de `max_connections` (lección
     T-185: API+worker de CADA réplica suman contra el mismo servidor).
   - Reaper: threshold ≥ la ejecución legítima más larga del tenant
     (`JANUSLY_GO_REAPER_THRESHOLD_MS`; el floor de 15m protege por
     default).
3. Proxy con split por familia (ejemplo Caddy en CUTOVER-MAP.md) y la
   lista @node de fases 4-5.

## Switch de un tenant

El estado vive en el mismo Postgres: el switch es SOLO de tráfico.

1. **Ventana tranquila**: elegir un momento sin campañas de replay ni
   rollouts activos del tenant (`GET /recovery/campaigns`,
   `GET /workflows/{id}/rollout`).
2. **Congelar entradas programadas** (opcional, tenants sensibles):
   pausar workflows con `schedule` (el tick en pausa se DESCARTA con
   audit — nunca thundering herd al reanudar).
3. **Mover la familia/tenant en el proxy** (matcher por header
   `x-org-id` si el split es por tenant, o por ruta si es por familia)
   y recargar.
4. **Smoke inmediato** (2 min): `GET /healthz`, un run de humo del
   tenant (`POST /start` de un workflow noop), `GET /v1/runs` y el tab
   Activity del web apuntado al proxy.

## Monitoreo (primeras 24h del tenant)

- `GET /health` (público-seguro): `rateLimiter` + `queue.degraded`.
- `GET /system/queue` (admin): waiting/active/oldest por cola.
- Métricas Prometheus (9464/9465): `go_goroutines`,
  `process_resident_memory_bytes`, `janusly_*` de colas y rate limits —
  los umbrales de referencia salen del soak (`conformance/perf/SOAK.md`).
- DLQ del tenant: `GET /dlq/counts` — un pico de firmas nuevas tras el
  switch es la señal de divergencia de comportamiento; comparar la firma
  contra el histórico ANTES de asumir bug de Go.
- Audit: `GET /audit?action=workflow.circuit_breaker` — breakers
  disparados post-switch.

## Rollback

1. Re-apuntar el matcher del tenant/familia a Node y recargar el proxy
   (< 1 min; sin migración de datos — mismo Postgres).
2. Los runs EN VUELO arrancados por Go terminan en Go si el proceso
   sigue vivo (drenar con SIGTERM: termina lo reclamado). Si Go murió:
   el reaper de Node NO conoce las filas `running` de Go — resolverlas
   con el redrive operativo (`POST /v1/dlq/redrive`) tras el reap manual
   (`UPDATE run_nodes SET ...` NO: usar el flujo DLQ).
3. Post-mortem con `make dual` + el caso que divergió añadido al corpus
   ANTES de reintentar el switch.

## Qué NO hacer

- No correr dos schedulers activos para el MISMO tenant en ambos
  backends (doble disparo de crons): el split de familia `schedule` es
  todo-o-nada por tenant.
- No "arreglar" divergencias editando datos: el comparador y el corpus
  son el mecanismo; los datos compartidos son la garantía del rollback.
