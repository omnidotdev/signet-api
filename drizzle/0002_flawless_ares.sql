CREATE TABLE "field" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"type" text NOT NULL,
	"page" integer NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"width" double precision NOT NULL,
	"height" double precision NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'detected' NOT NULL,
	"value" text
);
--> statement-breakpoint
ALTER TABLE "field" ADD CONSTRAINT "field_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;