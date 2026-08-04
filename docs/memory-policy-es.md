# Política de memoria de ejecución

La memoria de Janusly es opcional y controlada por cada organización. Puede
apoyar la generación de flujos, las sugerencias de recuperación y el contexto
del operador, pero nunca concede permisos ni reemplaza políticas.

Se activa únicamente cuando `JANUSLY_MEMORY_ENABLED=true` y la organización
habilita memoria con al menos un tipo permitido. Los registros se aíslan por
organización en PostgreSQL 18. El texto se limita, depura y se presenta al
modelo como datos no confiables.

La revocación de consentimiento programa una eliminación durable. La retención,
creación y purga son auditables sin registrar secretos ni el contenido completo
recordado.
