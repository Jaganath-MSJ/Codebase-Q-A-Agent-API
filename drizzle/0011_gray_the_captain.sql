ALTER TABLE "projects" ADD COLUMN "workspace_path" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "default_branch" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "head_revision" text;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_source_kind_check" CHECK ("projects"."source_kind" IN ('local_path','git_url','zip_upload','git_private'));