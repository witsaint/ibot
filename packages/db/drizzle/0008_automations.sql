CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"input" jsonb,
	"resume_message" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"summary" text,
	"error" text,
	"result_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"delivery_status" text,
	"delivery_body" jsonb,
	"delivery_url" text,
	"delivery_key" text,
	"delivery_attempts" integer DEFAULT 0 NOT NULL,
	"delivery_error" text,
	"delivery_next_at" timestamp with time zone,
	"delivery_lease" text,
	"delivery_lease_expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"instruction" text NOT NULL,
	"trigger" jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"needs_desktop" boolean DEFAULT true NOT NULL,
	"max_runs_per_day" integer DEFAULT 20 NOT NULL,
	"max_duration_seconds" integer DEFAULT 900 NOT NULL,
	"next_run_at" timestamp with time zone,
	"pause_reason" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"webhook_key" text,
	"callback_url" text,
	"callback_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_result_message_id_messages_id_fk" FOREIGN KEY ("result_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_event_unique" ON "automation_runs" USING btree ("automation_id","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_running_bot_unique" ON "automation_runs" USING btree ("bot_id") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "automation_runs_queue_idx" ON "automation_runs" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "automation_runs_rule_idx" ON "automation_runs" USING btree ("automation_id","created_at");--> statement-breakpoint
CREATE INDEX "automations_bot_idx" ON "automations" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "automations_due_idx" ON "automations" USING btree ("enabled","next_run_at");