ALTER TABLE "document" ADD COLUMN "owner_name" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "message" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "expiry_warned_at" timestamp with time zone;