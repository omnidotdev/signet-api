import { describe, expect, it } from "bun:test";

import { editorPage } from "./editorPage.ts";

describe("editorPage", () => {
  const html = editorPage(
    {
      id: "doc-1",
      name: "Lease",
      status: "draft",
      pdfBase64: "",
      signers: [],
      fields: [],
    } as unknown as Parameters<typeof editorPage>[0],
    "secret-manage-token",
  );

  it("never puts the manage token in a URL", () => {
    expect(html).not.toContain("?token=");
    expect(html).not.toContain("location.reload");
  });

  it("sends the token in a header and reopens by POST", () => {
    expect(html).toContain('"x-signet-manage-token": DATA.manageToken');
    expect(html).toContain('form.method = "post"');
  });
});
