# Informe de ola 3 — pilot Go

**Corte:** 2026-07-31 · rama `go-pilot` (108+ commits sobre `develop@1ad09028`)
· 31/31 tickets de la ola `done` (T-188 + T-069..T-098); 100/100 acumulados
en el plan (olas 1, 2 y 3 completas).

## Qué es el pilot ahora

Tras la ola 2 el pilot era un runtime con paridad; tras la ola 3 es una
**plataforma multi-tenant operable**: identidad real (cadena de proveedores
con Supabase + service token + dev headers), autorización central de dos
capas (roles + permisos con overrides por org y roles custom), rastro de
auditoría completo (147 acciones tipadas + lector keyset), límites de tasa
sin Redis con fail-open observable, el catálogo cerrado de configuración
por tenant gobernando de verdad, retención por org acotada por lotes,
telemetría de uso lista para el primer token AI, salud en dos niveles,
métricas con los nombres de los dashboards existentes, y el esquema
**propiedad de Go** (goose) — una base fresca se provisiona completa sin el
repo Node.

### Lo nuevo por área

| Área | Estado |
|---|---|
| Esquema/migraciones propiedad de Go (goose embebido, baseline 74 tablas, stamping de DBs pre-goose) | ✅ T-188 |
| Auth: PROVIDER_CHAIN (supabase → service-token → dev-headers), grant = fila `org_members`, backfill de huérfanos legacy | ✅ T-069..T-071 |
| Gate de arranque en producción (sin Supabase → rehúsa salvo override explícito; probado con proceso real) | ✅ T-078 |
| Authz central: registro anotado de ~50 rutas aplicado en el middleware vía `Request.Pattern` (un mount no puede olvidar su gate) | ✅ T-072/T-073 |
| Roles custom + overrides por org (semántica de REEMPLAZO, fail-closed) + piso anti-lockout admin (se probó a sí mismo) | ✅ T-074..T-077 |
| Audit: catálogo tipado (147 + pilot-actions), `Write` best-effort / `WithAuditTx` transaccional, retrofit a las 18 mutaciones, lector `GET /audit` keyset exacto (postura ms de T-058 extendida al insert) | ✅ T-076/T-081/T-082 |
| safePersistPayload formal (3 capas; property test: cero secretos sobreviven en 6 columnas jsonb) | ✅ T-083 |
| Rate limiter Postgres (ventana EN la PK, O(1), fail-open + degradación auditada 1×/bucket/día con dedupe multi-réplica) cableado a triggers (storm-guard, cierra T-040) y MCP writes (bucket por tool) | ✅ T-084/T-085 |
| Org config: catálogo COMPLETO (69 definiciones extraídas mecánicamente, guards anti-secreto verbatim, resolutor por capas puro) + consumidores (adhoc gate, consent MCP, ventanas de retención) | ✅ T-086/T-087 |
| Retención por org: tombstones + run_events/audit/usage por lotes acotados con legal hold y shape `cappedByMaxBatches` | ✅ T-088 |
| usage_events + seam de recorder process-global (la telemetría jamás rompe la llamada) + `/run/usage` real + rollup de costos 100-grupos+resto | ✅ T-089/T-090 |
| Health dos niveles (`/health` sin números vivos; `/system/queue` + `/system/rate-limiter` admin; edad por ELEGIBILIDAD) | ✅ T-091 |
| Prometheus con nombres de la referencia + `target_info` (Resource) + conflicto de bind probado | ✅ T-092 |
| Lane HA `make test-ha` (dos engines, una base) + matriz de bombas concurrentes en el RUNBOOK | ✅ T-093/T-094 |
| Soak `make soak` con veredicto direccional | ✅ T-095 (números abajo) |
| Contrato v1 OpenAPI 3.1 generado desde manifiesto puro + guard de deriva en `make ci` | ✅ T-096 |
| CI GitHub Actions: job `test_go` en los triggers existentes | ✅ T-097 (verde en push pendiente del batch del usuario) |

## Matriz de authz (resumen)

Dos capas sobre `org_members.role`, como la referencia: `requireRole`
(viewer < editor < admin) y `requirePermission` contra el catálogo cerrado
de 41 claves — cuando una ruta declara ambas, AMBAS pasan, en ese orden.
Overrides por org y roles custom viven en `org_roles` (built-ins virtuales
hasta override; custom con `inheritsFrom` de enum cerrado, fail-closed; la
semántica de `grantedPermissions` no-nulo es REEMPLAZO). El piso
anti-lockout coerciona `org.permissions.write` + `members.write` solo en el
override del admin built-in (auditado en `metadata.coerced`); un custom que
hereda de admin NO se coerciona (el caso `billing-admin`). La aplicación es
CENTRAL: el dispatcher resuelve `http.Request.Pattern` contra el registro
anotado — el sweep de tests recorre la tabla completa con un viewer
sembrado y verifica el 403 verbatim de cada gate.

## La evidencia que más pesa

1. **El lane HA probó la afirmación del REPORT-W2.** Dos engines con pools
   separados sobre una base: 75 DAGs de propiedad con starts repartidos,
   una campaña drenada por dos bombas (una sola auditoría de completion),
   80 wake-ups de retry sin duplicados — verde ×3. Y los cinco loops de
   fondo tienen cada uno su gemelo simultáneo probado (reaper: 5 varados →
   exactamente 5 DLQs; retención: dos barridos suman 300/300).
2. **El property test de secretos.** Una corrida sembrada con claves y
   material sensible en config y outputs: barrido de las 6 columnas jsonb
   del chokepoint — cero supervivencias, y el snapshot DLQ conserva su
   estructura reproducible con `[redacted]` en su sitio.
3. **El piso anti-lockout se probó solo.** El test de roles estrechó el
   admin built-in a una clave — y su propio actor siguió pudiendo revertir
   y expulsar, porque el piso le coercionó las dos claves obligatorias.
4. **Base fresca sin Node.** `janusly-go migrate` provisiona 74/74 tablas
   con goose embebido y la suite completa corre verde encima; el lane pg15
   pasa por el mismo camino.

## Soak (T-095)

Una hora de carga mixta sostenida (4 VUs arrancando workflows a terminal +
8 VUs de lecturas), 121 muestras cada 30 s del `/metrics` interno,
veredicto **ESTABLE** (el arnés falla con >10% de crecimiento entre el
primer y el último cuarto):

| Señal | Primer cuarto | Último cuarto | Δ | Dirección |
| --- | --- | --- | --- | --- |
| RSS | 32.5 MB | 33.2 MB | 2.2% | ◆ estable |
| Goroutines | 42 | 40 | −4.6% | ◆ estable |
| Heap in use | 9.7 MB | 9.9 MB | 1.8% | ◆ estable |

Serie completa en `conformance/perf/soak-ms93ees6.jsonl`; el binario
completo se quedó en ~33 MB de RSS tras una hora de carga.

## Divergencias deliberadas (corte de ola 3)

- **Limiter sin Redis** (decisión del operador): Postgres con la ventana en
  la PK; semántica fail-open y mensajes byte-iguales. La degradación audita
  con dedupe cross-réplica en DB (la referencia dedupea igual; el sustrato
  del contador difiere).
- **Esquema propiedad de goose** (decisión del operador): `pnpm migrate`
  queda PROHIBIDO sobre DBs goose; cada sync con develop espeja las
  migraciones drizzle nuevas como migraciones goose numeradas.
- **Los buckets AI no existen aún**: Node solo limita `/ai/*` y
  `mcp.rediscover` — cablear límites a start/save/resume habría CREADO
  divergencia. Llegan con la ola que porte `/ai/*`.
- **`maintenance: null`** en `/system/queue`: el pilot corre mantenimiento
  in-process, sin segunda cola — el campo es honesto, no un stub.
- **Audit `created_at` en ms** (extensión de la postura T-058): cierra un
  salto de frontera de página que la referencia aún carga (filas µs bajo
  cursor ms). Wire idéntico, estrictamente más correcto.
- **Tres acciones del pump de campañas** viven fuera del catálogo tipado de
  la referencia (su system-writer no tipa); se admiten vía
  `RegisterPilotAction` sin contaminar el pin de 147.
- **5 claves de org config** llevan validador custom en Node cuyos
  subsistemas no existen aún en el pilot (`HasDeferredValidator`); el
  pipeline estándar les aplica igual.

## Deuda restante (consciente)

- El verde del CI en push real espera el próximo batch de push (repo
  privada). El lane corre el `make ci` idéntico validado localmente.
- SSO WorkOS + SCIM: fuera del alcance de la ola (la cadena de auth deja el
  asiento del proveedor listo).
- `trigger.event.skipped` por rate-limit existe; los demás eventos skipped
  de la referencia llegan con sus triggers.
- Memoria/vector/agentes/AI: ola 4 — el sustrato de usage y el catálogo ya
  los esperan.

## Recomendación para la ola 4

Ejecutarla sobre esta base sin re-litigar sustratos: el pipeline AI
(T-099..T-128) tiene el seam de usage listo (T-089), el catálogo de config
con las claves `ai.*` ya ancladas (T-086), el limiter listo para el bucket
`ai` (T-084), y el contrato de fallback como tesis de la ola. Primer
ticket sugerido: T-101 (LlmClient) — el resto de la ola consume su seam.
