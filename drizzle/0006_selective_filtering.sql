ALTER TABLE "indexing_jobs" DROP CONSTRAINT "indexing_jobs_status_check";--> statement-breakpoint
DROP INDEX "one_active_job_per_project";--> statement-breakpoint
ALTER TABLE "indexing_jobs" ADD COLUMN "files_skipped" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "indexing_jobs" ADD COLUMN "skip_reasons" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "indexing_jobs" ADD COLUMN "embed_requests" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "indexing_jobs" ADD COLUMN "cancel_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_job_per_project" ON "indexing_jobs" USING btree ("project_id") WHERE "indexing_jobs"."status" IN ('queued','running','paused');--> statement-breakpoint
ALTER TABLE "indexing_jobs" ADD CONSTRAINT "indexing_jobs_status_check" CHECK ("indexing_jobs"."status" IN ('queued','running','succeeded','failed','canceled','paused'));