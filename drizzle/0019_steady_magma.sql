ALTER TABLE "document" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "previous_version_id" uuid;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_previous_version_id_document_id_fk" FOREIGN KEY ("previous_version_id") REFERENCES "public"."document"("id") ON DELETE set null ON UPDATE no action;