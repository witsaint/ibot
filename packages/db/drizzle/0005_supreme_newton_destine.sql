ALTER TABLE "bots" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;