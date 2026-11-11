CREATE TABLE "user_signature" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"typed_name" text,
	"image" text,
	"mode" text DEFAULT 'type' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
