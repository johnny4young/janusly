import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { loadRootEnv } from "./env";

loadRootEnv();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("Missing DATABASE_URL. Add it to .env or .env.example.");
}

export const client = postgres(connectionString, {
  onnotice: () => undefined,
});
export const db = drizzle(client);

export * from "./schema";
export * from "./env";
