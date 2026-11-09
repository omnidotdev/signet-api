import { Elysia, t } from "elysia";
import { getDb, runMigrations } from "./lib/db/client.ts";
import {
  createSigningRequest,
  getSignedPdf,
  getSignedPdfForSignToken,
  getSignerView,
  getStatus,
  signByToken,
  voidDocument,
} from "./lib/documents/documentService.ts";
import { signPdf } from "./lib/signing/pdfSigner.ts";
import { loadServiceSigner } from "./lib/signing/signerIdentity.ts";
import { landingPage, notFoundPage, signerPage } from "./lib/ui/pages.ts";

const signer = loadServiceSigner();
const port = Number(process.env.PORT ?? 3000);
const baseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
const hasDb = Boolean(process.env.DATABASE_URL);

if (hasDb) {
  await runMigrations();
} else {
  console.warn(
    "DATABASE_URL not set, send-for-signature disabled (quick-sign still works)",
  );
}

const html = (markup: string) =>
  new Response(markup, { headers: { "content-type": "text/html" } });
const pdfResponse = (bytes: Uint8Array, filename: string) =>
  new Response(bytes, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });

const app = new Elysia()
  .get("/", () => html(landingPage()))
  .get("/health", () => ({
    status: "ok",
    signer: signer.commonName,
    db: hasDb,
  }))
  // stateless quick-sign
  .post(
    "/api/sign",
    async ({ body }) => {
      const input = new Uint8Array(await body.file.arrayBuffer());
      const signed = await signPdf(input, signer.pkcs12, {
        name: body.name || signer.commonName,
        reason: "Signed with Signet",
        passphrase: signer.passphrase,
      });
      return pdfResponse(signed, "signed.pdf");
    },
    {
      body: t.Object({
        file: t.File({ type: "application/pdf" }),
        name: t.Optional(t.String()),
      }),
    },
  );

if (hasDb) {
  const db = getDb();

  app
    // create a signing request, returns shareable links
    .post(
      "/api/documents",
      async ({ body, set }) => {
        const pdf = new Uint8Array(await body.file.arrayBuffer());
        const req = await createSigningRequest(db, {
          name: body.name || body.file.name || "Document",
          pdf,
          signerName: body.signerName,
          signerEmail: body.signerEmail,
        });
        set.status = 201;
        return {
          id: req.id,
          signUrl: `${baseUrl}/sign/${req.signToken}`,
          manageUrl: `${baseUrl}/d/${req.id}?token=${req.manageToken}`,
        };
      },
      {
        body: t.Object({
          file: t.File({ type: "application/pdf" }),
          name: t.Optional(t.String()),
          signerName: t.String(),
          signerEmail: t.Optional(t.String()),
        }),
      },
    )
    // signer-facing page
    .get("/sign/:token", async ({ params }) => {
      const view = await getSignerView(db, params.token);
      if (!view) return html(notFoundPage());
      return html(
        signerPage(
          params.token,
          view.documentName,
          view.signerName,
          view.documentStatus === "completed" || view.signerStatus === "signed",
        ),
      );
    })
    // signer applies their signature
    .post("/sign/:token", async ({ params, set }) => {
      const result = await signByToken(db, signer, params.token);
      if (!result.ok) {
        set.status = result.error === "not_found" ? 404 : 409;
        return { ok: false, error: result.error };
      }
      return { ok: true };
    })
    // signer downloads their signed copy
    .get("/sign/:token/download", async ({ params, set }) => {
      const signed = await getSignedPdfForSignToken(db, params.token);
      if (!signed) {
        set.status = 404;
        return { error: "not_available" };
      }
      return pdfResponse(signed, "signed.pdf");
    })
    // sender status (manage token)
    .get("/d/:id", async ({ params, query, set }) => {
      const status = await getStatus(db, params.id, query.token ?? "");
      if (!status) {
        set.status = 404;
        return html(notFoundPage());
      }
      return status;
    })
    // sender downloads the signed document
    .get("/d/:id/signed", async ({ params, query, set }) => {
      const signed = await getSignedPdf(db, params.id, query.token ?? "");
      if (!signed) {
        set.status = 404;
        return { error: "not_available" };
      }
      return pdfResponse(signed, "signed.pdf");
    })
    // sender voids the request
    .post("/d/:id/void", async ({ params, query, set }) => {
      const ok = await voidDocument(db, params.id, query.token ?? "");
      if (!ok) {
        set.status = 404;
        return { ok: false };
      }
      return { ok: true };
    });
}

app.listen(port);

console.info(`Signet listening on ${baseUrl}`);
if (signer.ephemeral) {
  console.warn(
    "signing with an ephemeral identity, signatures will show an unknown issuer",
  );
}
