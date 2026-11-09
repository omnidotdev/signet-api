ALTER TABLE "field" ADD COLUMN "signer_id" uuid;--> statement-breakpoint
ALTER TABLE "signer" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "field" ADD CONSTRAINT "field_signer_id_signer_id_fk" FOREIGN KEY ("signer_id") REFERENCES "public"."signer"("id") ON DELETE set null ON UPDATE no action;