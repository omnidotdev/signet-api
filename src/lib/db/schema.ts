import {
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
  /** base64-encoded original PDF */
  originalPdf: text("original_pdf").notNull(),
  /** base64-encoded signed PDF, null until signed */
  signedPdf: text("signed_pdf"),
  /** capability token for the sender to track and manage the request */
  manageToken: text("manage_token").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Document = typeof document.$inferSelect;
export type Signer = typeof signer.$inferSelect;
export type SignatureEventRow = typeof signatureEvent.$inferSelect;
