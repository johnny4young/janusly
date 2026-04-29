import { client } from "./index";

let migrationsAsserted: Promise<void> | null = null;

type MigrationProbeClient = {
  unsafe(query: string): PromiseLike<unknown>;
};

export function assertMigrationsApplied() {
  migrationsAsserted ??= assertMigrationsAppliedForClient(client).catch((err) => {
    migrationsAsserted = null;
    throw err;
  });
  return migrationsAsserted;
}

export async function assertMigrationsAppliedForClient(migrationClient: MigrationProbeClient) {
  const rows = (await migrationClient.unsafe(
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations') AS exists",
  )) as { exists: boolean }[];

  if (!rows[0]?.exists) {
    throw new Error(
      "Database is not migrated. Run `pnpm migrate` against DATABASE_URL before starting the API/worker.",
    );
  }
}
