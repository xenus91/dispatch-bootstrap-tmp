CREATE TABLE "webhook_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"update_type" text,
	"outcome" text NOT NULL,
	"max_user_id" text,
	"error" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "webhook_events_created_idx" ON "webhook_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "webhook_events_outcome_idx" ON "webhook_events" USING btree ("outcome");