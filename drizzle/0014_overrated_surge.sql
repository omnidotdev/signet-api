ALTER TABLE "document" ADD COLUMN "verification_level" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "signer" ADD COLUMN "otp_code_hash" text;--> statement-breakpoint
ALTER TABLE "signer" ADD COLUMN "otp_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signer" ADD COLUMN "otp_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signer" ADD COLUMN "otp_attempts" integer DEFAULT 0 NOT NULL;