ALTER TABLE "indexing_jobs" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "indexing_jobs" ADD COLUMN "max_attempts" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "indexing_jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;