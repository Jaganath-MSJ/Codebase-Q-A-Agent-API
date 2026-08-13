CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX "chunks_trgm_gin" ON "chunks" USING gin ("search_text" gin_trgm_ops);