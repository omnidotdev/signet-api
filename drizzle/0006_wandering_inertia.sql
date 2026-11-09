ALTER TABLE "document" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signer" ADD COLUMN "last_reminder_at" timestamp with time zone;