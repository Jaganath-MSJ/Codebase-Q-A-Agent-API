ALTER TABLE "messages" ADD COLUMN "status" text DEFAULT 'complete' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "latency_ms" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_status_check" CHECK ("messages"."status" IN ('pending','streaming','complete','error'));