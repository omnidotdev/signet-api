import { describe, expect, it } from "bun:test";

import { renderRequest, requestSubject } from "./signatureRequestEmail.ts";

const base = {
  to: "ada@example.com",
  signerName: "Ada",
  documentName: "Lease",
  signUrl: "https://signet.example/sign/t",
};

describe("signing request email", () => {
  it("names the sender in the subject and greeting", () => {
    const input = { ...base, senderName: "Olive Owner" };
    expect(requestSubject(input)).toBe("Olive Owner sent you Lease to sign");
    expect(renderRequest(input)).toContain("Olive Owner sent you");
  });

  it("says when it is a reminder or about to expire", () => {
    expect(requestSubject({ ...base, kind: "reminder" })).toBe(
      "Reminder: please sign Lease",
    );
    const expiring = {
      ...base,
      kind: "expiring" as const,
      expiresAt: new Date("2026-12-03T12:00:00Z"),
    };
    expect(requestSubject(expiring)).toBe("Expires soon: please sign Lease");
    expect(renderRequest(expiring)).toContain("December 3, 2026");
  });

  it("shows the sender's note, escaped", () => {
    const html = renderRequest({
      ...base,
      senderName: "Olive",
      message: "<b>hi</b>\nthanks",
    });
    expect(html).toContain("Message from Olive:");
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;<br>thanks");
    expect(html).not.toContain("<b>hi</b>");
  });

  it("keeps a header on one line", () => {
    expect(requestSubject({ ...base, documentName: "A\r\nBcc: x" })).toBe(
      "Signature requested: A Bcc: x",
    );
  });
});
