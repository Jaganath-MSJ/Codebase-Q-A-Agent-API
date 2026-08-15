CREATE TABLE "source_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_credentials_project_id_unique" UNIQUE("project_id"),
	CONSTRAINT "source_credentials_kind_check" CHECK ("source_credentials"."kind" IN ('github_pat'))
);
--> statement-breakpoint
ALTER TABLE "source_credentials" ADD CONSTRAINT "source_credentials_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;