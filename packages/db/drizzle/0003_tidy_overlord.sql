CREATE TYPE "public"."agent_job_kind" AS ENUM('background', 'subagent');--> statement-breakpoint
DROP INDEX "agent_jobs_one_running_per_bot";--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "kind" "agent_job_kind" DEFAULT 'background' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "needs_desktop" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "result" text;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "parent_job_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_parent_job_id_agent_jobs_id_fk" FOREIGN KEY ("parent_job_id") REFERENCES "public"."agent_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_jobs_parent_idx" ON "agent_jobs" USING btree ("parent_job_id");