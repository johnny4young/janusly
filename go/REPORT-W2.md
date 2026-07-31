# Informe de ola 2 — pilot Go

**Corte:** 2026-07-31 · rama `go-pilot` (75 commits sobre `develop@7febb99c`,
pin sin deriva verificada) · 54/69 tickets `done` en el plan; los 30 del
goal de esta ola, completos.

## Qué es el pilot hoy

Un binario Go que sirve el API dual-wire (legacy byte-compatible + envelope
v1), ejecuta workflows con la cola EN Postgres (sin Redis), y sostiene la
app React de producción **sin tocarla**: boot, feed de actividad, panel de
run, redrive desde la UI, approve/resume desde la UI — cero errores de
página. El servidor MCP in-process expone ocho tools con consent de
escrituras de dos flags.

### Estado F1/F2 por área

| Área | Estado |
|---|---|
| Runtime (noop/transform/condition/http/wait_until/approval/tool/fork/join/loop/webhook_received) | ✅ paridad byte-igual, 18 fixtures |
| Dual wire legacy + v1 (cores compartidos) | ✅ estructural — un core, dos encoders |
| Triggers: ingest webhook + claim CAS + buffer-on-pause | ✅ (selector por workflow; §9) |
| Recovery: DLQ + filtros + clusters + redrive + campañas paced + métricas north-star | ✅ |
| Gate production-mode + badge de readiness | ✅ (sin credenciales; §9) |
| Org config: bounds http por tenant | ✅ subset |
| Streaming HTTP + familia CSV (fetch streaming) | ✅ |
| SSE + cursores de eventos exactos bidireccionales | ✅ (fix de precisión ms + orden ASC) |
| Retention sweep + timers masivos justos + idempotencia de start | ✅ |
| Floor Postgres 15 (lane completo) | ✅ |
| Fuzzing (11M entradas) + property tests (25 DAGs aleatorios) | ✅ |
| Web smokes (boot + loop del operador) | ✅ |

## La evidencia que más pesa

1. **Paridad reproducible.** Los 18 goldens recapturados en una corrida
   salieron byte-idénticos a los committeados; la paridad Go corre verde
   ×3. Seis fixtures nuevos (cancel, fork/join, loop×2, word-operators,
   strict policy) pasaron **al primer intento** — la fidelidad acumulada
   es real.
2. **Rendimiento sin regresión por features** (`perf/EVOLUTION.md`):
   start 209 runs/s (4.6× Node, p99 7.6× menor), list 6.7k req/s @ 10ms
   p95 sobre el peor caso, RSS ~22-43 MB en un proceso.
3. **El loop del operador desde la UI real**: fallo → panel → redrive →
   verde; gate → approve → fluye. La app de producción no sabe que habla
   con Go.

## Hallazgos regalados al backend Node (chips abiertos)

1. Límite de grupos con paréntesis en la gramática de expresiones.
2. Riesgo de run atascado por orden de declaración en el readiness scan
   (probablemente reproducido bajo carga: 2/445 diamantes).
3. `json.parse` clusteriza como `parse_error` genérico (prioridad de
   reglas de firma).
4. Índice keyset de runs sin tiebreaker `id` — O(runs-del-org) por página
   (17× medido); fix por el patrón two-file.

Además, dos hallazgos de compatibilidad que el pilot ya arregló de su
lado y que aplican a cualquier lector cruzado de la base compartida:
precisión ms de cursores sobre timestamps µs (salto de eventos en
frontera de página) y el orden ascendente de páginas de eventos.

## Divergencias vivas (decisión pendiente para F2/producción)

El corte curado completo vive en JOURNAL «corte de mitad de ola» + §9.
Las que condicionan adopción:

- **Sin audit rows** en ninguna mutación (transversal).
- **Tipos de nodo no ejecutables**: `ai`, `agent`, `mcp_tool`,
  `subworkflow`, `schedule`, resto de triggers.
- Selector webhook por workflow (no org-wide por clave); `buffered` sin
  backfill propio (drenable por Node sobre la misma tabla).
- Redrive revive-in-place (attempts avanzan; sin linaje de replay).
- `/dlq/queue` (read-model experto) y el resto de superficies de
  recovery avanzadas (playbooks, drills, feedback, rollouts).
- Sin rate-limiter (API, triggers, MCP) — el sustrato Redis no existe
  aquí; un limiter en Postgres/memoria es decisión de diseño pendiente.

## Riesgos honestos

- **Un solo proceso** = un solo dominio de fallo; el argumento operativo
  (runbook) lo convierte en virtud, pero HA real exige réplicas + el
  análisis de locks per-run bajo múltiples instancias (diseñado para
  ello — SKIP LOCKED + advisory por run — pero no probado multi-nodo).
- **El esquema compartido es de drizzle**: el pilot añade objetos
  `go_pilot_*` idempotentes; cualquier consolidación futura debe decidir
  quién es dueño del esquema.
- **Paridad de mensajes** cubre lo golden-verificado; superficies
  pilot-shaped (webhooks, campañas) tienen mensajes propios anotados.

## Recomendación

La ola 2 cierra F1 (web intacta sobre Go) y el grueso de F2 (recovery
operable end-to-end). Lo que separa el pilot de un despliegue serio no es
runtime sino plataforma: audit, limiter, y el resto del catálogo de org
config. Si el veredicto del timebox es continuar, la ola 3 natural es
«plataforma mínima creíble» (audit chokepoint + limiter en Postgres +
catálogo completo) más el primer despliegue supervisado con el runbook.
