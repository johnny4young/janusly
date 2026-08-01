# Soak — última corrida

- runId: msarvugo
- duración: 3m (muestras cada 15s, 14 muestras)
- k6: ok
- veredicto: **CRECIÓ — investigar antes de promover**

Comparación primer cuarto vs último cuarto de la corrida (una carga
sostenida con crecimiento >10% entre extremos señala fuga; el arranque
caliente queda absorbido por el promedio del primer cuarto).

| Señal | Primer cuarto | Último cuarto | Δ | Dirección |
| --- | --- | --- | --- | --- |
| RSS | 38.5 MB | 37.3 MB | -3.3% | ◆ estable |
| Goroutines | 43 | 42 | -3.8% | ◆ estable |
| Heap in use | 9.2 MB | 10.8 MB | 17.1% | ▲ creció |

Serie completa: `soak-msarvugo.jsonl`.
