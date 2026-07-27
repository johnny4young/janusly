ALTER TABLE "auto_healing_runs" ADD COLUMN "validation_evidence_level" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "validation_evidence_level" text;
