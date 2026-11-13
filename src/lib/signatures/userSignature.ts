import { eq } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { userSignature } from "../db/schema.ts";
import { signatureFontOrNull } from "../fields/signatureFonts.ts";

/** A user's adopted signature, reusable across their documents and devices */
export interface SavedSignature {
  typedName: string | null;
  image: string | null;
  mode: string;
  /** handwriting style of the typed signature, null for the classic style */
  font?: string | null;
}

/** Read a user's saved signature, or null when they have not adopted one */
export const getUserSignature = async (
  db: Db,
  ownerId: string,
): Promise<SavedSignature | null> => {
  const [row] = await db
    .select({
      typedName: userSignature.typedName,
      image: userSignature.image,
      mode: userSignature.mode,
      font: userSignature.font,
    })
    .from(userSignature)
    .where(eq(userSignature.ownerId, ownerId));
  return row ?? null;
};

/** Store (or replace) a user's saved signature */
export const saveUserSignature = async (
  db: Db,
  ownerId: string,
  data: SavedSignature,
): Promise<void> => {
  const values = {
    typedName: data.typedName ?? null,
    image: data.image ?? null,
    mode: data.mode,
    font: signatureFontOrNull(data.font),
    updatedAt: new Date(),
  };
  await db
    .insert(userSignature)
    .values({ ownerId, ...values })
    .onConflictDoUpdate({ target: userSignature.ownerId, set: values });
};
