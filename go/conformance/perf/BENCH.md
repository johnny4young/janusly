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

Última corrida: 2026-07-31T05:31:02.000Z @ `d1c2605e` · anterior: 2026-07-31T05:29:10.056Z @ `d1c2605e`

| Métrica | Dirección | Última | Anterior | Δ | Veredicto |
|---|---|---|---|---|---|
| start: runs terminados/s | ↑ mejor | 190 runs/s | 207 runs/s | -8.3% | ⚠️ regresión |
| start: latencia p50 | ↓ mejor | 48.0 ms | 48.0 ms | +0.0% | ≈ igual |
| start: latencia p95 | ↓ mejor | 73.0 ms | 51.0 ms | +43.1% | ⚠️ regresión |
| start: latencia p99 | ↓ mejor | 82.0 ms | — | — | — |
| list: lecturas/s | ↑ mejor | 1536 req/s | 8171 req/s | -81.2% | ⚠️ regresión |
| list: latencia p95 | ↓ mejor | 46.0 ms | 8.0 ms | +475.0% | ⚠️ regresión |
| diamond: DAGs terminados/s | ↑ mejor | 85.0 runs/s | 128 runs/s | -33.6% | ⚠️ regresión |
| diamond: latencia p95 | ↓ mejor | 190 ms | 118 ms | +61.0% | ⚠️ regresión |
| errores (todas las fases) | ↓ mejor | 0.0 | 0.0 | — | — |

Historial: 3 corrida(s) en `series.jsonl`.
