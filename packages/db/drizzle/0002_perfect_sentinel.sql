CREATE TYPE "public"."agent_job_status" AS ENUM('running', 'done', 'error', 'canceled');--> statement-breakpoint
CREATE TABLE "agent_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"status" "agent_job_status" DEFAULT 'running' NOT NULL,
	"instruction" text DEFAULT '' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_jobs_bot_idx" ON "agent_jobs" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_jobs_conversation_idx" ON "agent_jobs" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_jobs_one_running_per_bot" ON "agent_jobs" USING btree ("bot_id") WHERE "agent_jobs"."status" = 'running';