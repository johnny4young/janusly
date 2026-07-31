# Informe de ola 4 — pilot Go

**Corte:** 2026-07-31 · rama `go-pilot` (142 commits sobre `develop@103be9e8`)
· 30/30 tickets de la ola `done` (T-099..T-128); 130/130 acumulados en el
plan (olas 1–4 completas). Suite: 24 paquetes verdes con `-race` + goose;
lint 0; smoke web 4/4.

## Qué es el pilot ahora

Tras la ola 3 el pilot era una plataforma multi-tenant operable; tras la
ola 4 tiene el **pipeline AI completo con el contrato de degradación
sagrado probado superficie por superficie**: el chokepoint Anthropic-only
con clasificación estable de errores, generación free-JSON con escalera de
reparación + Best-of-N + presupuesto + guidance DATA-framed, el parche de
recovery con sobres deterministas, los nodos `ai`/`agent`/`multi_agent`
con planner LLM y memoria episódica consentida, la memoria vectorial
pgvector, el cliente MCP endurecido (SSRF pinned + sandbox stdio +
descubrimiento sanitizado NFKC), `human_form` con tokens HMAC firmados, y
las evals del harness Node corriendo verdes contra el binario a $0.

### Lo nuevo por área

| Área | Estado |
|---|---|
| Chokepoint `internal/ai` (anthropic-sdk-go, clases AIError estables, simulador doble-gate, usage por intento, pricing snapshot) | ✅ T-099..T-102 |
| `aiconfig` (resolver por org; proveedor ajeno → cliente sin configurar, nunca reroute) + `aibudget` (check/gate/gated-generate + audit) | ✅ T-103/T-105 |
| free-JSON: extractor de fences/llaves + reparación de truncado string-aware; nunca inventa sobre texto balanceado | ✅ T-104 |
| `/ai/generate-workflow`: prompt 21KB verbatim, escalera 2 intentos + reparación dirigida, 5 templates fallback + escalera de keywords, BoN clamp [1,5] con backoff por presupuesto | ✅ T-106/T-112 |
| Guidance `janusly.md` DATA-framed (8KiB/scope, 12KiB combinado, scrub apilado) + PromptOps (`prompts` + versiones inmutables + pin) | ✅ T-107/T-108 |
| `/ai/patch-workflow`: sobres config + estructural (insert_approval_upstream con recableado), alternativas saneadas, evidencia siempre | ✅ T-109/T-110 |
| Nodo `ai` (promptRef gana, fallo de proveedor NUNCA falla el nodo) + dry-run desde `runs.replay_mode` | ✅ T-111 |
| Memoria: sustrato pgvector 1024-dim con consentimiento dos-flags, `vector.search/upsert`, episodios de agente con fingerprints | ✅ T-113/T-115 |
| `agent` (escalera rules verbatim + planner LLM con recall episódico + write-skip en dry-run) + `multi_agent` (goal ligado tarde por agente completado; paralelo nunca difiere) | ✅ T-114/T-116/T-117 |
| `agent.reasoning` al contrato estable (caps 120/160/160/500 runas, replacesEventId, saneo control/bidi) | ✅ T-118 |
| Scopes diferidos (`previousAgents`/`item`) bajo política estricta EN el punto real de binding | ✅ T-119 |
| Cliente MCP: escalera de defensas completa, transportes URL SSRF-pinned, sandbox stdio (allowlist/vida/stderr vía cancel race-free), descubrimiento + sanitización NFKC + exposición 4-flags con caps 60/20KB, rutas admin writeSide/rate | ✅ T-120..T-122 |
| Catálogo único de fallos AI (`failcat`: 9 wire + 5 réplicas) consumido por CUATRO suites | ✅ T-123 |
| Evals Node contra Go: 3/3 deterministas, 27 skip limpio, gate intacto, exit 0 | ✅ T-124 |
| `/validate` paridad + `jsonSchema` planner-only fuera de `/tools` | ✅ T-125 |
| `human_form`: tokens HMAC org/run/node/purpose con expiración FIRMADA, `/resume` con schema + CAS (carrera probada) | ✅ T-126 |
| Smokes web: AI Studio $0 (generar→guardar→correr→aprobar) + human form por el dialog real; fix de paridad `/start` plano | ✅ T-127 |

## Paridad de evals

| Métrica | Node (baseline) | Go (esta ola) |
|---|---|---|
| Casos deterministas (template exigido) | 3/3 | **3/3** (ids clavados) |
| Casos `requiresMode:"ai"` | gate por tasa | **27/27 skip limpio** (fallback sin key no lleva `aiError` — el contrato exacto de skip) |
| Errores duros de transporte/HTTP/JSON | 0 | **0** |
| Exit del gate (`summarizeAi`/`compareToBaseline` sin tocar) | 0 | **0** |

La tasa ai-mode contra baseline queda sin medir a propósito: la corrida
dorada gasta créditos y es invocación del usuario (decisión vigente de la
ola 3). El harness corre sin fork — la paridad es del binario, no del
arnés.

## Costo real de la ola

**$0.00 en créditos de proveedor.** Ninguna clave real se configuró: cada
camino AI corrió contra el simulador doble-gate (costo persistido 0,
`providerSimulated: true`) o el fallback determinista. El ledger de uso sí
trabajó de verdad: 2.046 filas `llm.completion` (195.704 tokens contados
por el simulador; las filas con costo sintético son fixtures de los tests
de presupuesto), 334 filas de memoria/MCP. La infraestructura de
gobernanza de costo (presupuesto mensual, backoff de BoN, chips de costo)
quedó probada sin gastar un centavo.

## Divergencias AI vivas (aceptadas y documentadas)

1. **`garbage_200` clasifica `network`, no `unknown`** — el SDK Go reporta
   un 200 con cuerpo no-JSON como fallo de decode del transporte (proxy
   roto). Lectura honesta; clavada en `failcat`.
2. **Tasa ai-mode sin medir** — requiere créditos; diferida a corrida
   dorada del usuario.
3. **Ids fijos de templates de fallback** — paridad exacta con Node
   (`approval-gate` etc.); la colisión cross-org al guardar dos veces es
   una limitación real compartida del producto. El runner del smoke
   pre-limpia; el producto la hereda tal cual.
4. **`timeout`/`network_dead` fuera de las suites de superficie** — el
   piso del catálogo org (60s) no permite presupuestos sub-segundo; la
   suite del cliente los posee con seams de test.
5. **PromptOps sirve promptRefs de nodos, NO el prompt de generación** —
   hallazgo de arquitectura de la referencia portado como realidad (el
   prompt de 21KB va embebido, versionado por deploy).

## Recomendación ola 5 (Recovery avanzado + rollouts, T-129..T-158)

1. **Arrancar por el contrato de recovery** (RecoveryContractV1/V2 y el
   perfil de capacidades L0–L4): es la columna vertebral; el resto de la
   ola (casos durables, receipts, calibración) cuelga de ahí.
2. **Reusar las costuras de esta ola**: `replay_mode` ya propaga dry-run a
   ai/vector/agente/MCP — el gate de sandbox de la ola 5 es extenderlo, no
   reescribirlo; `failcat` debería crecer con las firmas de fallo de
   recovery en vez de un segundo catálogo.
3. **El circuito de replay ya tiene mimbres**: DLQ + campañas + claims
   causales existen de olas previas; la ola 5 añade el breaker y los
   receipts — mapear tickets contra lo ya portado ANTES de escribir código
   (el patrón "ya estaba en el baseline" apareció tres veces esta ola:
   tablas MCP, claves orgconfig, acciones de audit).
4. **Presupuestar una corrida dorada de evals** al cerrar la ola 5 si el
   pilot va a decidir el go/no-go — es el único número de paridad que
   sigue sin medirse.

## Diferidos (requieren decisión/acción del usuario)

- **Push por lotes + CI verde real** (`test_go` corre en el push; los 142
  commits siguen locales — regla de repo privado).
- **Corrida dorada de evals con clave real** (gasta créditos).
- **Receta PagerDuty** (puerto del flujo determinista prompt-generado) —
  no entró en el corte de la ola.
- **Enriquecimientos del patch**: calibración de confianza, memory-hint y
  localización de mensajes — la referencia los tiene detrás de flags que
  el pilot aún no expone.
- **Validación de subset `outputSchema`** en generación (la referencia lo
  valida al guardar; el pilot solo al ejecutar).
