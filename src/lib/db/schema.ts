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
  /**
   * identity assurance required of each signer before they may sign:
   * none (possession of the link, plus any access code) | email_otp (a
   * one-time code emailed to the signer must be entered first)
   */
  verificationLevel: text("verification_level").notNull().default("none"),
  /** when the draft was sent, the baseline for reminder timing */
  sentAt: timestamp("sent_at", { withTimezone: true }),
  /** Gatekeeper subject of the signed-in sender, null for anonymous sends */
  ownerId: text("owner_id"),
  /** workspace (Gatekeeper organization) the document belongs to, null if none */
  organizationId: text("organization_id"),
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
  /** optional access code the signer must enter to open the document */
  accessCode: text("access_code"),
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
  /** bcrypt hash of the signer's current one-time verification code, if issued */
  otpCodeHash: text("otp_code_hash"),
  /** when the current one-time code expires; a code past this is never accepted */
  otpExpiresAt: timestamp("otp_expires_at", { withTimezone: true }),
  /** when this signer's identity was verified by one-time code; sticky once set */
  otpVerifiedAt: timestamp("otp_verified_at", { withTimezone: true }),
  /** failed attempts against the current code, to lock out brute force */
  otpAttempts: integer("otp_attempts").notNull().default(0),
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
  /** signature | date | initials | text | checkbox | dropdown | radio */
  type: text("type").notNull(),
  /** choices for a dropdown or radio field, as a JSON array of strings */
  options: text("options"),
  /** links the buttons of one radio group; they are mutually exclusive */
  groupId: text("group_id"),
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
  /** sender-chosen date style for a date field: iso | us | eu | long, null = iso */
  dateFormat: text("date_format"),
  /** sender-chosen ink for this field's mark, as #rrggbb; null uses the default */
  color: text("color"),
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

/** A signed-in user's adopted signature, reused across their documents and devices */
export const userSignature = pgTable("user_signature", {
  /** Gatekeeper subject of the user; one saved signature per account */
  ownerId: text("owner_id").primaryKey(),
  /** the typed full name, when the user adopted a typed signature */
  typedName: text("typed_name"),
  /** base64 PNG of a drawn or uploaded signature */
  image: text("image"),
  /** type | draw | upload: how the signature was adopted, to restore the editor */
  mode: text("mode").notNull().default("type"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Document = typeof document.$inferSelect;
export type Field = typeof field.$inferSelect;
export type Signer = typeof signer.$inferSelect;
export type SignatureEventRow = typeof signatureEvent.$inferSelect;
export type Template = typeof template.$inferSelect;
export type UserSignature = typeof userSignature.$inferSelect;
