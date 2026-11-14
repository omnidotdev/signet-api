import { describe, expect, test } from "bun:test";

import { sendNotices } from "./sendNotices.ts";

const signer = (name: string, email: string | null, active = true) => ({
  name,
  email,
  signToken: `${name}-token`,
  active,
});

describe("notices when a sender sends a draft", () => {
  test("emails every signer whose turn it is", () => {
    const { email, senderSignsNow } = sendNotices(
      [signer("Ada", "ada@x.com"), signer("Grace", "grace@x.com")],
      "owner@x.com",
    );
    expect(email.map((s) => s.name)).toEqual(["Ada", "Grace"]);
    expect(senderSignsNow).toBe(false);
  });

  test("the sender, as a signer, signs in the app instead of being emailed", () => {
    const { email, senderSignsNow } = sendNotices(
      [signer("Me", "Owner@X.com"), signer("Grace", "grace@x.com")],
      "owner@x.com",
    );
    expect(email.map((s) => s.name)).toEqual(["Grace"]);
    expect(senderSignsNow).toBe(true);
  });

  test("a signer whose turn has not come is neither emailed nor signing now", () => {
    const { email, senderSignsNow } = sendNotices(
      [signer("Grace", "grace@x.com"), signer("Me", "owner@x.com", false)],
      "owner@x.com",
    );
    expect(email.map((s) => s.name)).toEqual(["Grace"]);
    expect(senderSignsNow).toBe(false);
  });

  test("signers without an email are skipped", () => {
    expect(sendNotices([signer("Ada", null)], "owner@x.com").email).toEqual([]);
  });
});
