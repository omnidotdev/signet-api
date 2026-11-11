import { beforeEach, describe, expect, test } from "bun:test";

import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { getUserSignature, saveUserSignature } from "./userSignature.ts";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

describe("user signature", () => {
  test("returns null before the user adopts one", async () => {
    expect(await getUserSignature(db, "user-1")).toBeNull();
  });

  test("saves and reads back a typed signature", async () => {
    await saveUserSignature(db, "user-1", {
      typedName: "Ada Lovelace",
      image: null,
      mode: "type",
    });
    expect(await getUserSignature(db, "user-1")).toMatchObject({
      typedName: "Ada Lovelace",
      image: null,
      mode: "type",
    });
  });

  test("replaces the saved signature on re-save (upsert)", async () => {
    await saveUserSignature(db, "user-1", {
      typedName: "Ada",
      image: null,
      mode: "type",
    });
    await saveUserSignature(db, "user-1", {
      typedName: null,
      image: "data:image/png;base64,AAAA",
      mode: "draw",
    });
    expect(await getUserSignature(db, "user-1")).toMatchObject({
      typedName: null,
      image: "data:image/png;base64,AAAA",
      mode: "draw",
    });
  });

  test("is scoped per user", async () => {
    await saveUserSignature(db, "user-1", {
      typedName: "Ada",
      image: null,
      mode: "type",
    });
    expect(await getUserSignature(db, "user-2")).toBeNull();
  });
});
