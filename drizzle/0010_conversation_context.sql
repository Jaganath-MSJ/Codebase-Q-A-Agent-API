ALTER TABLE "conversations" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "summarized_through_msg_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "retrieval_query" text;