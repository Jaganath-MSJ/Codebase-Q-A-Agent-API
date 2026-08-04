ALTER TABLE "indexing_jobs" ADD COLUMN "phase" text;--> statement-breakpoint
ALTER TABLE "indexing_jobs" ADD COLUMN "chunks_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "indexing_jobs" ADD COLUMN "chunks_embedded" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "indexing_jobs" ADD COLUMN "current_path" text;--> statement-breakpoint
ALTER TABLE "indexing_jobs" ADD CONSTRAINT "indexing_jobs_phase_check" CHECK ("indexing_jobs"."phase" IN ('acquiring','walking','chunking','embedding','finalizing'));