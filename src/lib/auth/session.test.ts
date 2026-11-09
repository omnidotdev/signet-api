import { describe, expect, test } from "bun:test";
import type { OAuthTransaction, Session } from "./session.ts";
import {
  signSession,
  signTransaction,
  verifySession,
  verifyTransaction,
} from "./session.ts";

const SECRET = "test-secret-at-least-32-bytes-long-xx";
const OTHER = "a-completely-different-secret-value-yy";

const session: Session = {
  sub: "user-123",
  email: "ada@example.com",
  name: "Ada Lovelace",
};

const tx: OAuthTransaction = {
  state: "state-abc",
  nonce: "nonce-def",
  verifier: "pkce-verifier-ghi",
  returnTo: "/dashboard",
};

describe("session cookie", () => {
  test("round-trips a signed session", async () => {
    const token = await signSession(session, SECRET);
    expect(await verifySession(token, SECRET)).toEqual(session);
  });

  test("rejects a session signed with a different secret", async () => {
    const token = await signSession(session, SECRET);
    expect(await verifySession(token, OTHER)).toBeNull();
  });

  test("rejects a missing or malformed token", async () => {
    expect(await verifySession(undefined, SECRET)).toBeNull();
    expect(await verifySession("not-a-jwt", SECRET)).toBeNull();
  });

  test("rejects an expired session", async () => {
    const token = await signSession(session, SECRET, "-1s");
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  test("tolerates a session without a name", async () => {
    const token = await signSession({ sub: "u", email: "e@x.co" }, SECRET);
    expect(await verifySession(token, SECRET)).toEqual({
      sub: "u",
      email: "e@x.co",
      name: undefined,
    });
  });
});

describe("oauth transaction cookie", () => {
  test("round-trips a signed transaction", async () => {
    const token = await signTransaction(tx, SECRET);
    expect(await verifyTransaction(token, SECRET)).toEqual(tx);
  });

  test("rejects a transaction signed with a different secret", async () => {
    const token = await signTransaction(tx, SECRET);
    expect(await verifyTransaction(token, OTHER)).toBeNull();
  });

  test("rejects a missing or malformed token", async () => {
    expect(await verifyTransaction(undefined, SECRET)).toBeNull();
    expect(await verifyTransaction("garbage", SECRET)).toBeNull();
  });
});
