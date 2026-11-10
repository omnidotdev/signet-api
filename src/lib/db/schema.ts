import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** A document uploaded for signature, with its original and signed bytes */
export const document = pgTable("document", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  /** draft | sent | completed | voided */
  status: text("status").notNull().default("draft"),
  contentHash: text("content_hash").notNull(),
  /** base64-encoded original PDF, empty when stored in object storage */
  originalPdf: text("original_pdf").notNull(),
  /** object-storage key for the original PDF, null when stored inline */
  originalPdfKey: text("original_pdf_key"),
  /** base64-encoded signed PDF, null until signed, empty when in object storage */
  signedPdf: text("signed_pdf"),
  /** object-storage key for the signed PDF, null when stored inline */
  signedPdfKey: text("signed_pdf_key"),
  /** capability token for the sender to track and manage the request */
  manageToken: text("manage_token").notNull(),
  /** parallel (any order) | sequential (one signer at a time by orderIndex) */
  signingMode: text("signing_mode").notNull().default("parallel"),
  /** when the draft was sent, the baseline for reminder timing */
  sentAt: timestamp("sent_at", { withTimezone: true }),
  /** Gatekeeper subject of the signed-in sender, null for anonymous sends */
  ownerId: text("owner_id"),
  /** denormalized sender email for dashboard display */
  ownerEmail: text("owner_email"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** A party asked to sign a document */
export const signer = pgTable("signer", {
  id: uuid("id").defaultRandom().primaryKey(),
  documentId: uuid("document_id")
    .notNull()
    .references(() => document.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email"),
  /** capability token embedded in the signer's shareable link */
  signToken: text("sign_token").notNull(),
  /** pending | viewed | signed | declined */
  status: text("status").notNull().default("pending"),
  orderIndex: integer("order_index").notNull().default(0),
  /** hex color used to tint this signer's fields in the editor */
  color: text("color"),
  /** base64 PNG of a drawn signature, stamped into this signer's fields */
  signatureImage: text("signature_image"),
  /** when this signer was last reminded, to rate-limit reminder emails */
  lastReminderAt: timestamp("last_reminder_at", { withTimezone: true }),
  signedAt: timestamp("signed_at", { withTimezone: true }),
});

/** One tamper-evident provenance event in a document's history */
export const signatureEvent = pgTable("signature_event", {
  id: uuid("id").defaultRandom().primaryKey(),
  documentId: uuid("document_id")
    .notNull()
    .references(() => document.id, { onDelete: "cascade" }),
  index: integer("index").notNull(),
  type: text("type").notNull(),
  data: jsonb("data").notNull(),
  prevHash: text("prev_hash").notNull(),
  hash: text("hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * A fillable field placed on a document: a signature, date, initials, or text
 * box at a position on a page. Positions are PDF points with a bottom-left
 * origin (matching pdf-lib), so a detected position stamps where it was found.
 */
export const field = pgTable("field", {
  id: uuid("id").defaultRandom().primaryKey(),
  documentId: uuid("document_id")
    .notNull()
    .references(() => document.id, { onDelete: "cascade" }),
  /** the signer who fills this field, null until assigned */
  signerId: uuid("signer_id").references(() => signer.id, {
    onDelete: "set null",
  }),
  /** signature | date | initials | text */
  type: text("type").notNull(),
  /** 1-based page number */
  page: integer("page").notNull(),
  x: doublePrecision("x").notNull(),
  y: doublePrecision("y").notNull(),
  width: doublePrecision("width").notNull(),
  height: doublePrecision("height").notNull(),
  required: boolean("required").notNull().default(true),
  /** how the field was placed: detected | manual */
  source: text("source").notNull().default("detected"),
  /** value stamped at sign time (typed signature, date string), null until then */
  value: text("value"),
});

/** A field position stored on a reusable template */
export interface TemplateField {
  type: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A reusable document + field layout an owner can start new documents from */
export const template = pgTable("template", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  /** Gatekeeper subject of the owner; templates are account-scoped */
  ownerId: text("owner_id").notNull(),
  /** base64-encoded PDF */
  pdfBase64: text("pdf_base64").notNull(),
  /** the field layout, applied to the first signer on use */
  fields: jsonb("fields").notNull().$type<TemplateField[]>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Document = typeof document.$inferSelect;
export type Field = typeof field.$inferSelect;
export type Signer = typeof signer.$inferSelect;
export type SignatureEventRow = typeof signatureEvent.$inferSelect;
export type Template = typeof template.$inferSelect;
