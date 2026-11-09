import { Elysia, t } from "elysia";
import { loadAuthConfig } from "./lib/auth/config.ts";
import {
  buildAuthorizeUrl,
  completeLogin,
  createPkce,
  randomToken,
} from "./lib/auth/oidc.ts";
import {
  signSession,
  signTransaction,
  verifySession,
  verifyTransaction,
} from "./lib/auth/session.ts";
import { getDb, runMigrations } from "./lib/db/client.ts";
import {
  createSigningRequest,
  getSignedPdf,
  getSignedPdfForOwner,
  getSignedPdfForSignToken,
  getSignerView,
  getStatus,
  listDocumentsByOwner,
  signByToken,
  voidDocument,
} from "./lib/documents/documentService.ts";
import { sendSignatureRequestEmail } from "./lib/email/signatureRequestEmail.ts";
import { signPdf } from "./lib/signing/pdfSigner.ts";
import { loadServiceSigner } from "./lib/signing/signerIdentity.ts";
import {
  authBar,
  dashboardPage,
  landingPage,
  notFoundPage,
  signerPage,
} from "./lib/ui/pages.ts";

const signer = loadServiceSigner();
const port = Number(process.env.PORT ?? 3000);
const baseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
const hasDb = Boolean(process.env.DATABASE_URL);

const authConfig = loadAuthConfig(baseUrl);
const authEnabled = authConfig !== null;
const secureCookies = baseUrl.startsWith("https");

const SESSION_COOKIE = "signet_session";
const TX_COOKIE = "signet_tx";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

if (hasDb) {
  await runMigrations();
} else {
  console.warn(
    "DATABASE_URL not set, send-for-signature disabled (quick-sign still works)",
  );
}
if (!authEnabled) {
  console.warn(
    "SIGNET_OAUTH_CLIENT_ID/SECRET or SIGNET_SESSION_SECRET not set, sender accounts disabled (anonymous send still works)",
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
  // Resolve the signed-in sender from the session cookie for every request
  .derive(async ({ cookie }) => {
    const raw = cookie[SESSION_COOKIE]?.value;
    const token = typeof raw === "string" ? raw : undefined;
    return {
      session:
        authEnabled && authConfig
          ? await verifySession(token, authConfig.sessionSecret)
          : null,
    };
  })
  .get("/", ({ session }) =>
    html(landingPage(authEnabled ? authBar(session?.email) : "")),
  )
  .get("/health", () => ({
    status: "ok",
    signer: signer.commonName,
    db: hasDb,
    auth: authEnabled,
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

if (authEnabled && authConfig) {
  const cfg = authConfig;

  app
    // start the OIDC login: stash state/nonce/PKCE, redirect to Gatekeeper
    .get("/login", async ({ cookie, set }) => {
      const state = randomToken();
      const nonce = randomToken();
      const { verifier, challenge } = createPkce();
      const tx = await signTransaction(
        { state, nonce, verifier, returnTo: "/dashboard" },
        cfg.sessionSecret,
      );
      cookie[TX_COOKIE]?.set({
        value: tx,
        httpOnly: true,
        secure: secureCookies,
        sameSite: "lax",
        path: "/",
        maxAge: 600,
      });
      set.status = 302;
      set.headers.location = await buildAuthorizeUrl(cfg, {
        state,
        nonce,
        challenge,
      });
      return null;
    })
    // OIDC callback: validate, exchange, open a session
    .get("/auth/callback", async ({ query, cookie, set }) => {
      const rawTx = cookie[TX_COOKIE]?.value;
      const tx = await verifyTransaction(
        typeof rawTx === "string" ? rawTx : undefined,
        cfg.sessionSecret,
      );
      cookie[TX_COOKIE]?.remove();
      const code = typeof query.code === "string" ? query.code : undefined;
      const state = typeof query.state === "string" ? query.state : undefined;

      set.status = 302;
      if (!tx || !code || !state || tx.state !== state) {
        set.headers.location = "/?auth_error=1";
        return null;
      }
      try {
        const session = await completeLogin(cfg, code, tx.verifier, tx.nonce);
        const token = await signSession(session, cfg.sessionSecret);
        cookie[SESSION_COOKIE]?.set({
          value: token,
          httpOnly: true,
          secure: secureCookies,
          sameSite: "lax",
          path: "/",
          maxAge: SESSION_MAX_AGE,
        });
        set.headers.location = tx.returnTo || "/dashboard";
      } catch (err) {
        console.warn("[signet] login failed", err);
        set.headers.location = "/?auth_error=1";
      }
      return null;
    })
    // sign out
    .post("/logout", ({ cookie, set }) => {
      cookie[SESSION_COOKIE]?.remove();
      set.status = 302;
      set.headers.location = "/";
      return null;
    });
}

if (hasDb) {
  const db = getDb();

  app
    // create a signing request, returns shareable links
    .post(
      "/api/documents",
      async ({ body, session, set }) => {
        const pdf = new Uint8Array(await body.file.arrayBuffer());
        const documentName = body.name || body.file.name || "Document";
        const req = await createSigningRequest(db, {
          name: documentName,
          pdf,
          signerName: body.signerName,
          signerEmail: body.signerEmail,
          ownerId: session?.sub,
          ownerEmail: session?.email,
        });
        const signUrl = `${baseUrl}/sign/${req.signToken}`;
        if (body.signerEmail) {
          await sendSignatureRequestEmail({
            to: body.signerEmail,
            signerName: body.signerName,
            documentName,
            signUrl,
          });
        }
        set.status = 201;
        return {
          id: req.id,
          signUrl,
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
          view.fields,
        ),
      );
    })
    // signer applies their signature (optionally an adopted typed signature)
    .post(
      "/sign/:token",
      async ({ params, body, set }) => {
        const result = await signByToken(
          db,
          signer,
          params.token,
          body?.signature,
        );
        if (!result.ok) {
          set.status = result.error === "not_found" ? 404 : 409;
          return { ok: false, error: result.error };
        }
        return { ok: true };
      },
      {
        body: t.Optional(t.Object({ signature: t.Optional(t.String()) })),
      },
    )
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

  if (authEnabled) {
    app
      // the owner dashboard: every document the signed-in sender created
      .get("/dashboard", async ({ session, set }) => {
        if (!session) {
          set.status = 302;
          set.headers.location = "/login";
          return null;
        }
        const docs = await listDocumentsByOwner(db, session.sub);
        return html(dashboardPage(session.email, docs));
      })
      // owner downloads a signed document, authorized by session, not a token
      .get("/dashboard/d/:id/signed", async ({ session, params, set }) => {
        if (!session) {
          set.status = 302;
          set.headers.location = "/login";
          return null;
        }
        const signed = await getSignedPdfForOwner(db, params.id, session.sub);
        if (!signed) {
          set.status = 404;
          return { error: "not_available" };
        }
        return pdfResponse(signed, "signed.pdf");
      });
  }
}

app.listen(port);

console.info(`Signet listening on ${baseUrl}`);
if (signer.ephemeral) {
  console.warn(
    "signing with an ephemeral identity, signatures will show an unknown issuer",
  );
}
