ALTER TABLE "chunks" ADD COLUMN "search_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED;--> statement-breakpoint
CREATE INDEX "chunks_tsv_gin" ON "chunks" USING gin ("tsv");