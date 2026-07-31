# Piloto Go — journal consolidado (F0)

Fecha: 2026-07-30 · Rama: `go-pilot` · Pin de referencia: `develop @ 0f294ad2`
Fuente viva: [`go/JOURNAL.md`](JOURNAL.md) (cronológico) y
[`go/PLAN.md`](PLAN.md) §9 (registro de decisiones). Este documento
consolida; no reemplaza.

## 1. Qué costó MENOS que en TS

- **La cola.** La tesis "la fila ES la cola" eliminó categorías enteras de
  código de Node: sin `queuePublicationGeneration`, sin marcadores de
  reparación, sin reconcilers de publicación — la transición de fila es la
  publicación. El fan-in exacto salió de UN advisory lock por run
  (completación + evento + readiness + rollup = una transacción). El retry
  diferido no necesitó scheduler: un anti-join contra `go_pilot_wakeups`
  hace reclamable la fila en el instante en que su reloj pasa.
- **Atomicidad.** `startRun`, completación, fallo terminal + DLQ, resume y
  redrive son transacciones únicas triviales de razonar. En Node varias de
  estas son secuencias multi-paso con reconcilers cubriendo las ventanas.
- **El MCP server.** Seis tools sobre el engine EN PROCESO (sin HTTP), con
  worker pool incluido: un agente opera el motor sin ningún otro servicio
  levantado. ~400 líneas con el SDK oficial.
- **Concurrencia probada.** `-race` en cada corrida + tests de carrera
  reales (8 workers/50 nodos exactly-once, drain sin huérfanos) — el race
  detector es un colaborador que TS no tiene.

## 2. Qué costó MÁS que en TS

- **Semántica JS explícita.** `undefined` vs `null` como `(value, present)`,
  truthiness, coerción `Number()` (hex/octal/`Infinity`/`""→0`), orden de
  strings por unidades UTF-16, igualdad laxa — un archivo entero
  (`jsvalue.go`) para lo que JS da gratis. Cada coerción es ahora auditable,
  pero hubo que ESCRIBIRLA.
- **jsonb y tipos de sqlc.** Los overrides de timestamptz necesitan las DOS
  formas (`pg_catalog.timestamptz` y `timestamptz`); mezclar `sqlc.arg()`
  con posicionales rompe la numeración; `json.RawMessage` en args de tools
  MCP deriva schema de array. Gotchas de una tarde cada uno.
- **El goteo de paridad.** Los mensajes byte-exactos (errores del evaluador,
  envelopes, códigos) exigieron leer la fuente en cada tarea. Pagó — la
  paridad F01–F10 salió a la primera — pero es disciplina cara.

## 3. Divergencias aceptadas (resumen; detalle en PLAN §9)

| Divergencia | Tipo |
| --- | --- |
| Redrive preserva `attempts` (+1); el replay de Node re-arma a 1 | producto, decidir en F2 |
| Scan de readiness a punto fijo (Node: una pasada por orden de declaración) | superior — Node puede ATASCARSE; reproducido en carga (2/445 diamantes) |
| Error al evaluar condición de arista → falsa determinista (Node: throw al job) | postura pilot |
| Approval con deadline declarado → fallo determinista (no ejecutar sin supervisión) | postura pilot |
| `node.redriven` como evento propio; DLQ queda `open` tras redrive | anotada |
| Errores Go planos sin `name` (JS siempre `name:"Error"`) | menor |
| `==`/`===` con operandos no escalares → false (JS: referencias/ToPrimitive) | menor |
| Gramática de paréntesis: `(A||B) && C` rechazado — IGUAL que Node (verificado en vivo) | paridad, reportado upstream |

## 4. Hallazgos sobre la referencia (regalos del piloto)

1. **Grupos booleanos entre paréntesis fuera de la gramática** — verificado
   en vivo; afecta autores y el prompt del LLM. Reportado (chip).
2. **Runs atascables por orden de declaración** en `enqueueReadyNodes` —
   análisis de fuente + reproducción probable bajo carga (2/445 diamantes de
   Node nunca completaron; Go 4100/4100). Reportado (chip).
3. **403 indistinguible** para runs desconocidos y cross-org — capturado en
   goldens; habría escrito 404 sin ellos.
4. El replay de Node re-arma attempts; `error_json` nunca se limpia al
   completar un nodo redriveado (ambos lados lo heredan).

## 5. Números (detalle en `go/conformance/perf/`)

Go gana 4× en throughput de runs y 2.6× en lecturas con ~5× menos memoria
en un proceso; a 50 VUs el pool degrada feo (sospechoso: `MaxConns 10`
fijo — follow-up concreto), donde BullMQ degrada con gracia. Sin umbral
pasa/no-pasa: son números para decidir con la cabeza fría.

## 6. T-1xx (stretch)

No ejecutadas en F0 (T-101 schedules, T-102 LlmClient Go, T-103 PDF,
T-104 embed.FS) — ninguna bloqueaba la vertical. Siguen en el plan.

## 7. Veredicto de fricción (condición 4 de la puerta)

Ninguna fricción fue prohibitiva. Las dos caras del costo real: (a) la
semántica JS hay que escribirla a mano UNA vez por gramática — y las
gramáticas ya están; (b) las 271 rutas restantes son volumen, no riesgo
nuevo: el patrón ruta→handler→golden quedó establecido en T-012. El riesgo
técnico que el piloto debía retirar (¿la cola propia sostiene la semántica
de Node?) está retirado con paridad medida.
