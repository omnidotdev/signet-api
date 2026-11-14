import { describe, expect, it } from "bun:test";

import { eventLabel } from "./eventLabel";

describe("eventLabel", () => {
  it("labels every event the ledger records", () => {
    for (const type of [
      "document.created",
      "document.sent",
      "document.viewed",
      "document.signed",
      "document.completed",
      "document.declined",
      "document.voided",
      "document.revised",
      "identity.verified",
      "signer.added",
      "signer.removed",
      "signer.corrected",
    ]) {
      const label = eventLabel(type);
      expect(label).not.toContain(".");
      expect(label[0]).toBe(label[0]?.toUpperCase());
    }
    expect(eventLabel("document.signed")).toBe("Signed");
  });

  it("capitalizes an event it has no label for", () => {
    expect(eventLabel("document.reminder_sent")).toBe("Reminder sent");
  });
});
