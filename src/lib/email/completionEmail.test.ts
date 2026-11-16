import { afterEach, describe, expect, it, spyOn } from "bun:test";

import { notifications } from "../providers/index.ts";
import {
  completionAttachments,
  sendCompletionEmail,
} from "./completionEmail.ts";

const email = {
  to: "ada@example.com",
  recipientName: "Ada",
  documentName: "Lease 2026/27.pdf",
  downloadUrl: "https://signet.example/sign/t",
};
const files = {
  signedPdf: new Uint8Array([1, 2, 3]),
  certificatePdf: new Uint8Array([4, 5]),
};

let spy: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
  spy?.mockRestore();
  spy = null;
});

describe("completion attachments", () => {
  it("names both files after the document, never as a path", () => {
    const files2 = completionAttachments(email.documentName, files);
    expect(files2.map((f) => f.filename)).toEqual([
      "Lease 2026 27.pdf",
      "Lease 2026 27 certificate.pdf",
    ]);
    expect(files2.every((f) => f.contentType === "application/pdf")).toBe(true);
  });

  it("attaches only the signed PDF when there is no certificate", () => {
    expect(
      completionAttachments("Lease", { ...files, certificatePdf: null }),
    ).toHaveLength(1);
  });
});

describe("sendCompletionEmail", () => {
  it("sends the finished files attached", async () => {
    spy = spyOn(notifications, "sendEmail").mockResolvedValue({
      success: true,
    });
    await sendCompletionEmail(email, files);
    expect(spy).toHaveBeenCalledTimes(1);
    const sent = spy.mock.calls[0]?.[0] as {
      attachments?: unknown[];
      body: string;
    };
    expect(sent.attachments).toHaveLength(2);
    expect(sent.body).toContain("are attached");
  });

  it("falls back to the link alone when the attached send is refused", async () => {
    spy = spyOn(notifications, "sendEmail")
      .mockResolvedValueOnce({ success: false, error: "attachments_too_large" })
      .mockResolvedValueOnce({ success: true });
    await sendCompletionEmail(email, files);
    expect(spy).toHaveBeenCalledTimes(2);
    const retry = spy.mock.calls[1]?.[0] as {
      attachments?: unknown[];
      body: string;
    };
    expect(retry.attachments).toBeUndefined();
    expect(retry.body).not.toContain("are attached");
  });

  it("sends the link alone when there are no files", async () => {
    spy = spyOn(notifications, "sendEmail").mockResolvedValue({
      success: true,
    });
    await sendCompletionEmail(email, null);
    expect(spy).toHaveBeenCalledTimes(1);
    const sent = spy.mock.calls[0]?.[0] as
      | { attachments?: unknown[] }
      | undefined;
    expect(sent?.attachments).toBeUndefined();
  });
});
