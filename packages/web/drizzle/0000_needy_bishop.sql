CREATE TABLE "access_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"staff_id" integer,
	"phone" text,
	"max_user_id" text,
	"detail" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" integer NOT NULL,
	"type" text NOT NULL,
	"stop_id" integer,
	"message" text,
	"raised_by_id" integer,
	"raised_by_name" text,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by_id" integer,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" integer NOT NULL,
	"history_id" integer,
	"uploaded_by_id" integer,
	"kind" text DEFAULT 'image' NOT NULL,
	"file_name" text,
	"max_token" text,
	"max_url" text,
	"stored_url" text,
	"size_bytes" integer,
	"stop_id" integer,
	"action_key" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_outbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_id" integer,
	"max_user_id" text,
	"text" text NOT NULL,
	"payload_json" text,
	"state" text DEFAULT 'stub' NOT NULL,
	"error" text,
	"max_message_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_state" (
	"max_user_id" text PRIMARY KEY NOT NULL,
	"staff_id" integer,
	"step" text DEFAULT 'idle' NOT NULL,
	"request_id" integer,
	"invite_id" integer,
	"data_json" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"inn" text,
	"address" text,
	"contact_name" text,
	"phone" text,
	"email" text,
	"comment" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "container_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "container_types_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"staff_id" integer NOT NULL,
	"created_by_id" integer,
	"ttl_hours" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "invites_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "operation_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"point_kinds_json" text DEFAULT '[]' NOT NULL,
	"actions_json" text DEFAULT '[]' NOT NULL,
	"extra_actions_json" text DEFAULT '[]' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_id" integer NOT NULL,
	"code" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "points" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"lat" double precision,
	"lon" double precision,
	"contact_name" text,
	"phone" text,
	"schedule" text,
	"comment" text,
	"client_id" integer,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_updates" (
	"key" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_stops" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" integer NOT NULL,
	"seq" integer NOT NULL,
	"point_id" integer NOT NULL,
	"operation_type_id" integer NOT NULL,
	"operation_snapshot_json" text NOT NULL,
	"planned_arrival_at" timestamp with time zone,
	"arrived_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"done_actions_json" text DEFAULT '[]' NOT NULL,
	"reminder_sent_at" timestamp with time zone,
	"late_alert_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_type_stops" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_type_id" integer NOT NULL,
	"seq" integer NOT NULL,
	"label" text NOT NULL,
	"point_kind" text NOT NULL,
	"operation_type_id" integer NOT NULL,
	"optional" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"request_type_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"container_no" text NOT NULL,
	"container_type_id" integer NOT NULL,
	"cargo_weight_t" double precision NOT NULL,
	"comment" text,
	"status" text DEFAULT 'new' NOT NULL,
	"driver_id" integer,
	"created_by_id" integer,
	"is_test" boolean DEFAULT false NOT NULL,
	"reminder_minutes" integer,
	"driver_message_id" text,
	"current_stop_id" integer,
	"assigned_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "requests_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"staff_id" integer NOT NULL,
	"kind" text DEFAULT 'web' NOT NULL,
	"user_agent" text,
	"ip" text,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" serial PRIMARY KEY NOT NULL,
	"role" text DEFAULT 'driver' NOT NULL,
	"full_name" text NOT NULL,
	"phone" text NOT NULL,
	"max_user_id" text,
	"max_chat_id" text,
	"max_username" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"block_reason" text,
	"access_until" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"login_failures" integer DEFAULT 0 NOT NULL,
	"login_locked_until" timestamp with time zone,
	"vehicle" text,
	"note" text,
	"created_by_id" integer,
	"activated_at" timestamp with time zone,
	"blocked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "staff_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "status_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" integer NOT NULL,
	"status" text NOT NULL,
	"actor_kind" text DEFAULT 'driver' NOT NULL,
	"actor_id" integer,
	"actor_name" text,
	"comment" text,
	"latitude" text,
	"longitude" text,
	"stop_id" integer,
	"action_key" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "access_kind_idx" ON "access_events" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "alerts_request_idx" ON "alerts" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "alerts_ack_idx" ON "alerts" USING btree ("acknowledged_at");--> statement-breakpoint
CREATE INDEX "attachments_request_idx" ON "attachments" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "outbox_staff_idx" ON "bot_outbox" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "clients_name_idx" ON "clients" USING btree ("name");--> statement-breakpoint
CREATE INDEX "invites_staff_idx" ON "invites" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "otp_staff_idx" ON "otp_codes" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "points_kind_idx" ON "points" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "points_client_idx" ON "points" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "stops_request_idx" ON "request_stops" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "rts_type_idx" ON "request_type_stops" USING btree ("request_type_id");--> statement-breakpoint
CREATE INDEX "requests_status_idx" ON "requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "requests_driver_idx" ON "requests" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "requests_client_idx" ON "requests" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "sessions_staff_idx" ON "sessions" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "staff_max_user_idx" ON "staff" USING btree ("max_user_id");--> statement-breakpoint
CREATE INDEX "staff_role_idx" ON "staff" USING btree ("role");--> statement-breakpoint
CREATE INDEX "history_request_idx" ON "status_history" USING btree ("request_id");