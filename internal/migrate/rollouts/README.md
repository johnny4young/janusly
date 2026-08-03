# Production rollouts (runbooks de ops — goose NO los corre)

Variantes `CREATE INDEX CONCURRENTLY` de los índices hot-path: aplicar con
`psql -v ON_ERROR_STOP=1 -f <archivo>` ANTES del deploy que trae la
migración del mismo número; el `IF NOT EXISTS` de la migración corta en
no-op después. (goose rechaza dos archivos con la misma versión, por eso
viven fuera de `sql/`.)
