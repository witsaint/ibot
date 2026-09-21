CREATE TYPE "public"."secret_kind" AS ENUM('apikey', 'bearer', 'header', 'oauth');--> statement-breakpoint
CREATE TYPE "public"."secret_owner" AS ENUM('bot', 'user');--> statement-breakpoint
CREATE TABLE "tenant_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_type" "secret_owner" NOT NULL,
	"bot_id" uuid,
	"user_id" text,
	"name" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_hint" text NOT NULL,
	"kind" "secret_kind" NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_mcp_servers" ADD COLUMN "box_local" jsonb;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "files" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "secret_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_secrets" ADD CONSTRAINT "tenant_secrets_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_secrets" ADD CONSTRAINT "tenant_secrets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_secrets_bot_name" ON "tenant_secrets" USING btree ("bot_id","name") WHERE owner_type = 'bot';--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_secrets_user_name" ON "tenant_secrets" USING btree ("user_id","name") WHERE owner_type = 'user';--> statement-breakpoint
CREATE INDEX "tenant_secrets_bot_idx" ON "tenant_secrets" USING btree ("bot_id");