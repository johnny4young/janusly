# Soak — última corrida

- runId: ms93ees6
- duración: 60m (muestras cada 30s, 121 muestras)
- k6: ok
- veredicto: **ESTABLE**

Comparación primer cuarto vs último cuarto de la corrida (una carga
sostenida con crecimiento >10% entre extremos señala fuga; el arranque
caliente queda absorbido por el promedio del primer cuarto).

| Señal | Primer cuarto | Último cuarto | Δ | Dirección |
| --- | --- | --- | --- | --- |
| RSS | 32.5 MB | 33.2 MB | 2.2% | ◆ estable |
| Goroutines | 42 | 40 | -4.6% | ◆ estable |
| Heap in use | 9.7 MB | 9.9 MB | 1.8% | ◆ estable |

Serie completa: `soak-ms93ees6.jsonl`.
