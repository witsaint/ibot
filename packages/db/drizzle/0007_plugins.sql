CREATE TYPE "public"."plugin_owner" AS ENUM('user', 'org');--> statement-breakpoint
CREATE TYPE "public"."plugin_source" AS ENUM('builtin', 'installed', 'local');--> statement-breakpoint
CREATE TABLE "plugin_installs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"owner_type" "plugin_owner" NOT NULL,
	"owner_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"enabled_bots" jsonb,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"version" text NOT NULL,
	"source" "plugin_source" NOT NULL,
	"display_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"author" jsonb,
	"homepage" text,
	"manifest" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"requires" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_secrets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_mcp_servers" ADD COLUMN "plugin_id" uuid;--> statement-breakpoint
ALTER TABLE "bot_setup_steps" ADD COLUMN "plugin_id" uuid;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "plugin_id" uuid;--> statement-breakpoint
ALTER TABLE "plugin_installs" ADD CONSTRAINT "plugin_installs_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_installs_plugin_owner_unique" ON "plugin_installs" USING btree ("plugin_id","owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "plugin_installs_owner_idx" ON "plugin_installs" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugins_key_version_unique" ON "plugins" USING btree ("key","version");--> statement-breakpoint
ALTER TABLE "bot_mcp_servers" ADD CONSTRAINT "bot_mcp_servers_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_setup_steps" ADD CONSTRAINT "bot_setup_steps_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_mcp_servers_plugin_idx" ON "bot_mcp_servers" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "bot_setup_steps_plugin_idx" ON "bot_setup_steps" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "skills_plugin_idx" ON "skills" USING btree ("plugin_id");