import { afterEach, describe, expect, it } from "vitest";

const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

describe("loadRootEnv", () => {
  it("preserves environment variables supplied by the process", async () => {
    const processDatabaseUrl = "postgresql://process.example/janusly";
    process.env.DATABASE_URL = processDatabaseUrl;

    const { loadRootEnv } = await import("./env");
    loadRootEnv();

    expect(process.env.DATABASE_URL).toBe(processDatabaseUrl);
  });
});
