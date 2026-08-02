# Soak — última corrida

- runId: msas0wmu
- duración: 24h (muestras cada 60s, 1412 muestras)
- k6: ok
- veredicto: **CRECIÓ — investigar antes de promover**

Comparación primer cuarto vs último cuarto de la corrida (una carga
sostenida con crecimiento >10% entre extremos señala fuga; el arranque
caliente queda absorbido por el promedio del primer cuarto).

| Señal | Primer cuarto | Último cuarto | Δ | Dirección |
| --- | --- | --- | --- | --- |
| RSS | 36.3 MB | 32.9 MB | -9.4% | ▼ bajó |
| Goroutines | 41 | 41 | -0.7% | ◆ estable |
| Heap in use | 7.1 MB | 8.8 MB | 24.4% | ▲ creció |

Serie completa: `soak-msas0wmu.jsonl`.

## Anexo T-510 — investigación del veredicto (2026-08-02)

El veredicto automático marcó "CRECIÓ" por el +24.4% de heap entre primer
y último cuarto — es un ARTEFACTO del baseline, no una fuga:

- Heap por octavos: 8.7 · **5.5** · 8.8 · 8.9 · 8.9 · 8.8 · 8.8 · 8.9 MB —
  plano en ~8.8 MB durante las últimas ~18 horas. El segundo octavo cayó a
  5.5 MB (la caída del Postgres del host + las ventanas SIGSTOP de los
  benches T-508/T-535 congelaron la carga), deprimiendo el promedio del
  primer cuarto a 7.1 MB. La cola no subió; el baseline bajó.
- RSS: tendencia a la BAJA (35.5 → 32.8 MB por octavos; final 28.0 MB;
  el pico global de 42.5 MB fue la muestra 2, el arranque).
- Goroutines: planas (~41; rango 28–54 = churn normal de workers).

Lectura honesta: **ESTABLE — sin fuga**. Una carga sostenida de 24h con
heap plano, RSS decreciente y goroutines planas no admite otra
conclusión; el detector de >10% entre cuartos extremos necesita un
baseline sin ventanas de congelamiento (mejora anotada para el próximo
relanzamiento: excluir muestras bajo SIGSTOP/outage del promedio).
