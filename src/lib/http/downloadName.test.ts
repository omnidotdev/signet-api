import { describe, expect, it } from "bun:test";

import { contentDisposition, pdfFileName } from "./downloadName";

describe("pdfFileName", () => {
  it("names the file after the document", () => {
    expect(pdfFileName("TopCrush OA")).toBe("TopCrush OA.pdf");
    expect(pdfFileName("TopCrush OA", "certificate")).toBe(
      "TopCrush OA certificate.pdf",
    );
  });

  it("does not double the extension of an uploaded file name", () => {
    expect(pdfFileName("lease.PDF")).toBe("lease.pdf");
    expect(pdfFileName("offer.docx")).toBe("offer.pdf");
  });

  it("drops characters a file system rejects", () => {
    expect(pdfFileName('a/b: "c"')).toBe("a b c.pdf");
    expect(pdfFileName("  ")).toBe("document.pdf");
  });
});

describe("contentDisposition", () => {
  it("keeps a plain name readable and quotes it safely", () => {
    expect(contentDisposition("attachment", "TopCrush OA.pdf")).toBe(
      "attachment; filename=\"TopCrush OA.pdf\"; filename*=UTF-8''TopCrush%20OA.pdf",
    );
  });

  it("carries non-ASCII names in UTF-8 with an ASCII fallback", () => {
    expect(contentDisposition("inline", "Café.pdf")).toBe(
      "inline; filename=\"Caf_.pdf\"; filename*=UTF-8''Caf%C3%A9.pdf",
    );
  });
});
