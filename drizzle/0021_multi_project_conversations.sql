CREATE TABLE "conversation_projects" (
	"conversation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	CONSTRAINT "conversation_projects_conversation_id_project_id_pk" PRIMARY KEY("conversation_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "citations" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_projects" ADD CONSTRAINT "conversation_projects_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_projects" ADD CONSTRAINT "conversation_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;