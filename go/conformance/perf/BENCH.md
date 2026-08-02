# Bench de regresión (k6)

Corridas secuenciales de 20s por escenario contra el binario Go en la
máquina local (`make bench`). La serie completa vive en `series.jsonl`;
cada fila compara la última corrida contra la anterior.

**Cómo leer la tabla:** la columna *Dirección* dice qué significa un
número más grande — `↑ mejor` (rendimiento: más es mejor) o `↓ mejor`
(latencia y errores: menos es mejor). *Δ* es el cambio relativo frente a
la corrida anterior; *Veredicto* ya aplica la dirección por ti.

**Ruido esperado:** cada corrida agranda la base de datos (~10k filas de
runs/nodos), así que corridas consecutivas no son idénticas; deltas de
hasta ±20% en rendimiento pueden ser ruido de crecimiento o térmico.
Una regresión real se confirma con dos corridas seguidas en la misma
dirección o un cambio de más del 25%.

Última corrida: 2026-08-01T22:19:27.658Z @ `e44af31d` · anterior: 2026-08-01T22:14:36.005Z @ `e44af31d`

| Métrica | Dirección | Última | Anterior | Δ | Veredicto |
|---|---|---|---|---|---|
| start: runs terminados/s | ↑ mejor | 89.7 runs/s | 67.3 runs/s | +33.3% | ✅ mejora |
| start: latencia p50 | ↓ mejor | 103 ms | 110 ms | -6.4% | ✅ mejora |
| start: latencia p95 | ↓ mejor | 169 ms | 479 ms | -64.6% | ✅ mejora |
| start: latencia p99 | ↓ mejor | 276 ms | 696 ms | -60.3% | ✅ mejora |
| list: lecturas/s | ↑ mejor | 2638 req/s | 2953 req/s | -10.7% | ⚠️ regresión |
| list: latencia p95 | ↓ mejor | 35.0 ms | 23.0 ms | +52.2% | ⚠️ regresión |
| diamond: DAGs terminados/s | ↑ mejor | 42.5 runs/s | 58.2 runs/s | -26.9% | ⚠️ regresión |
| diamond: latencia p95 | ↓ mejor | 388 ms | 284 ms | +36.8% | ⚠️ regresión |
| errores (todas las fases) | ↓ mejor | 0.0 | 0.0 | — | — |

Historial: 14 corrida(s) en `series.jsonl`.

## Perfil de allocs T-508 (2026-08-01, commit posterior a `e44af31d`)

Artefactos: `profiles/t508-bench.allocs` + `profiles/t508-bench.heap`,
capturados del puerto interno (`/debug/pprof/`) a mitad de una corrida de
`make bench` con el soak congelado (SIGSTOP).

**Lectura del perfil macro** (alloc_space, top del binario bajo carga):

1. `httpapi.getRun` — 39% acumulado: la serialización del detalle de run
   (JSON reflect sobre `map[string]any`) domina el read-path del bench.
   Destino natural: T-527 (views tipadas) — un encoder sobre structs
   elimina `mapEncoder` + `reflect.unsafe_New`.
2. `auth.EffectivePermissions` — 6.7%: reconstruye el set de permisos por
   request; cacheable por (org, rol) si algún perfil futuro lo confirma
   como cuello real.
3. `regexp.(*bitState).reset` — 4.5%: el matching de claves sensibles
   (`IsSensitiveKey`) y patrones de ruta; memoizable por clave exacta.

**Optimización medida (chokepoint `SafePersistPayload`)**: los dos
walkers de redacción (`RedactValues` / `RedactSensitiveKeys`) copiaban el
árbol completo incondicionalmente en cada persistencia de evento. Ahora
son copy-on-write: un contenedor se reconstruye solo cuando un cambio
real ocurre debajo (payload limpio = paso de solo-lectura, cero copias).
A/B intercalado con `git stash` (mismo proceso de medición, soak
congelado), mediana de 8 corridas, payload realista de ~20 filas:

| Caso | allocs/op | B/op | ns/op |
|---|---|---|---|
| Limpio (común) antes | 494 | 31 469 | 74 µs |
| Limpio después | **383 (−22.5%)** | **14 897 (−52.7%)** | **52 µs (−30%)** |
| Claves sensibles después | 401 (−21.4%) | 16 634 (−49.6%) | — |
| Valores redactados después | 532 (−29.4%) | 17 447 (−65.7%) | — |

**Veredicto del residuo**: el 75% de los objetos alocados del chokepoint
es el `encoding/json.Marshal` reflect final — irreducible sin un encoder
manual (riesgo de divergencia de bytes) o cambio de librería; queda
documentado, no atacado. El guard `TestRedactionWalkersDoNotMutateInput`
fija que los walkers COW jamás mutan el árbol del caller.

## Escenario hostil (T-535) — 2026-08-02T03:33:22.212Z @ `f2a85520`

Lecturas bajo caos (DLQ creciendo + breaker disparando, 1928 starts fallidos):
p95 hostil debe quedar bajo 2× el baseline sano.

| Lectura | p95 sano | p95 hostil | ratio | veredicto |
|---|---|---|---|---|
| runs list | 3.9 ms | 4.8 ms | 1.22× | ✅ acotado |
| dlq list | 3.6 ms | 5.1 ms | 1.41× | ✅ acotado |
| health | 0.2 ms | 0.2 ms | 1.34× | ✅ acotado |

Serie: `hostile-series.jsonl`.
