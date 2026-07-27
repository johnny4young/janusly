const DEFAULT_POSTGRES_PORT = 15_432;
const DEFAULT_REDIS_PORT = 16_379;

function parsePort(raw, fallback, name) {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

export function getIntegrationEnvironment(source = process.env) {
  const postgresPort = parsePort(
    source.JANUSLY_INTEGRATION_POSTGRES_PORT,
    DEFAULT_POSTGRES_PORT,
    "JANUSLY_INTEGRATION_POSTGRES_PORT",
  );
  const redisPort = parsePort(
    source.JANUSLY_INTEGRATION_REDIS_PORT,
    DEFAULT_REDIS_PORT,
    "JANUSLY_INTEGRATION_REDIS_PORT",
  );
  if (postgresPort === redisPort) {
    throw new Error("integration Postgres and Redis host ports must be different");
  }

  return {
    JANUSLY_POSTGRES_HOST_PORT: String(postgresPort),
    JANUSLY_REDIS_HOST_PORT: String(redisPort),
    DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${postgresPort}/workflow`,
    REDIS_URL: `redis://127.0.0.1:${redisPort}`,
  };
}
