CREATE TABLE "indexing_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text DEFAULT 'initial' NOT NULL,
	"files_total" integer DEFAULT 0 NOT NULL,
	"files_done" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "indexing_jobs_status_check" CHECK ("indexing_jobs"."status" IN ('queued','running','succeeded','failed','canceled'))
);
--> statement-breakpoint
ALTER TABLE "indexing_jobs" ADD CONSTRAINT "indexing_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "indexing_jobs_status_created_idx" ON "indexing_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_job_per_project" ON "indexing_jobs" USING btree ("project_id") WHERE "indexing_jobs"."status" IN ('queued','running');