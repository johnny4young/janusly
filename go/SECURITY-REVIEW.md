# Revisión de seguridad del pilot — T-186 (2026-08-01)

Método: re-corrida de las matrices ejecutables + dos piezas nuevas
(sweep authz de rango editor, scrub e2e por el WIRE) + inventario de
superficies con su evidencia. Todo lo listado corre en la suite
(`make test` / lanes etiquetadas); nada de esto es prosa sin test.

## 1. Egreso HTTP / SSRF

| Superficie | Chokepoint | Evidencia |
| --- | --- | --- |
| Nodo `http` | `httpExecutor.validate` + dial pinneado | `TestSSRFMatrixRejectsEveryBlockedClass` (loopback/privadas/link-local/metadata), `TestRebindingResolverCannotRedirectTheDial`, `TestDialRefusesUnvalidatedAndPrivatePins` |
| Tool `http.request` (nuevo T-184) | `FetchHTTPTarget` (mismo executor) | `TestHTTPRequestToolBlocksPrivateTargets` (metadata AWS + loopback), `TestHTTPRequestToolProjectsDeclaredJSON` |
| `csv.fetch`, integraciones (Slack/GitHub/webhook/PagerDuty/upstream/email/external-runtime) | todas vía `FetchHTTPTarget` — cero SDKs con dial propio | suites por módulo + grep-invariante (ningún `http.Client` fuera del chokepoint en tools) |
| MCP URL transports | `NewPinnedHTTPClient` (valida ANTES de construir; el client solo marca la IP pinneada) | `TestMcpClientHTTPTransport` (privado + rebinding) |
| Redirects | re-validación POR SALTO + strip de credenciales cross-origin | matriz del executor |

Escape hatch: `ALLOW_PRIVATE_HTTP_TARGETS=true` explícito (dev/tests).

## 2. Secretos / scrubbing

| Capa | Cobertura |
| --- | --- |
| Escritura (chokepoint `SafePersistPayload`) | `run_events.payload`, `run_nodes.state_json/error_json`, `dead_letters.*` (workflow/node key-redaction sin cap de bytes), `audit_logs.metadata` — `internal/grammar/safepersist_test.go` |
| Lectura/exports (defensa en profundidad) | firmas normalizadas, eval exports re-scrub, stderr MCP, AI guidance — suites de signature/evals/mcp |
| **E2E por el wire** | `TestSecretScrubEndToEnd`: secreto plantado en config+input de un run fallido → `/v1/dlq`, `/dlq?id=` (snapshots exactos) y `/audit` NO lo llevan; `[redacted]` presente; lo no-sensible sobrevive |
| Gate de producción | el mismo test: `JANUSLY_PRODUCTION_MODE=true` → `/start` 422 ante valores secret-shaped hardcodeados |

**Riesgo residual documentado (compartido con el reference):**
`runs.input_json` NO está en el chokepoint — un secreto hardcodeado en
config/input persiste verbatim y sale por el detalle del run en DEV. La
postura sancionada es `{{secret.X}}`/`{{env.X}}` + el gate de
producción. Flag levantado al repo Node (task `runs.inputJson`), donde
la fuga es idéntica; el precedente `dead_letters.workflow_json`
(key-redactado pese a servir replays) sugiere que redactar es lo
consistente cuando se decida en el reference.

## 3. Authz (dos capas sobre el registry central)

- Registry cerrado: patrón no listado = auth-only; la completitud la
  exige el sweep (visitó N==len(routeAuthz)).
- **Matriz por rango**: `TestRouteRegistrySweepAsViewer` (rango mínimo:
  cada gate editor/admin rechaza con el 403 del reference; cada read de
  viewer pasa ambas capas) + `TestRouteRegistrySweepAsEditor` (nuevo:
  admin-gated → 403 de rol; permisos fuera del set default de editor →
  403 de permiso; el resto pasa).
- Capa de permisos independiente: `TestPermissionLayerRejectsIndependently`.
- Multi-tenancy: predicados org-scoped por handler; 404/403 opacos
  cross-org (`runs_forbidden` uniforme) — contract suite.

## 4. Firmas de webhooks entrantes (inventario completo)

| Receptor | Esquema | Fail-closed sin secreto | Evidencia |
| --- | --- | --- | --- |
| WorkOS SCIM | `t=<ms>,v1=` HMAC-SHA256, ±300s, constant-time | sí | `TestVerifyWorkOsSignature` + lifecycle |
| External runtime | `t=,v1=` ±300s sobre raw body | sí (401) | suite external-runtime (skew/tamper) |
| PagerDuty V3 | `v1=` multi-candidato constant-time | sí | suite pagerduty (defensa) |
| Slack interacciones | firma propia + verificación del raw body | sí | suite slack |
| Human-form resume | token HMAC org/run/node/purpose + expiry firmado | n/a (token requerido) | suite humanform |

## 5. SQL / sandbox / límites

- Tools `db.*`: gramática cerrada (sin `;`, sin comentarios, clases de
  verbo, placeholders contiguos), DSN por credencial org-scoped, pools
  1-conn máx 5/org, `safeDbError` redacta DSNs — `dbquery_test.go`.
- MCP stdio: allowlist de comandos, env whitelist, cwd temp, watchdog de
  vida, cap de stderr con tail redactado.
- Rate limits: por org (+credencial en db tools), fail-open documentado
  con tracker de degradación.
- Consent gates: memoria dos flags, MCP writes dos flags, eval datasets
  `accepted AND eval_consent` con doble scrub.

## 6. Hallazgos de ESTA revisión

1. **Leak de conexión LISTEN** (T-185, corregido): el stream hub
   secuestraba su conexión fuera del pool con contexto Background;
   `NewV1HandlerWithShutdown` + cleanup en harnesses.
2. **`runs.input_json` fuera del chokepoint** (§2, residual documentado
   + flag al reference).
3. Sweep editor y matriz SSRF del tool `http.request` no existían —
   añadidos y verdes.
