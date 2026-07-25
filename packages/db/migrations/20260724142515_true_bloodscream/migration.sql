CREATE TABLE IF NOT EXISTS "credential_secret_versions" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"version" integer NOT NULL,
	"ciphertext" text NOT NULL,
	"data_nonce" text NOT NULL,
	"data_tag" text NOT NULL,
	"wrapped_key" text NOT NULL,
	"wrap_nonce" text NOT NULL,
	"wrap_tag" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
UPDATE "credentials" SET "updated_at" = now() WHERE "updated_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "credentials" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credential_secret_versions_credential_version_idx" ON "credential_secret_versions" ("credential_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credential_secret_versions_org_credential_idx" ON "credential_secret_versions" ("org_id","credential_id","created_at" DESC NULLS LAST);--> statement-breakpoint
-- Pre-existing duplicate (org_id, name) rows would make the unique index below
-- fail mid-migration. Keep the most recently updated row's name (rotation bumps
-- updated_at, so that is the live one) and rename the rest with a suffix that is
-- unique by construction (id is the primary key). Renamed rows stay resolvable
-- by their new name so no credential data is lost; operators can review and
-- delete them afterwards. Runs after the updated_at backfill above.
UPDATE "credentials" AS c
SET "name" = c."name" || '-dup-' || c."id"
WHERE EXISTS (
  SELECT 1 FROM "credentials" AS newer
  WHERE newer."org_id" = c."org_id"
    AND newer."name" = c."name"
    AND newer."id" <> c."id"
    AND (newer."updated_at" > c."updated_at"
      OR (newer."updated_at" = c."updated_at" AND newer."id" > c."id"))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credentials_org_name_idx" ON "credentials" ("org_id","name");
