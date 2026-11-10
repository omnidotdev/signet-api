import { createRequire } from "node:module";
import { Elysia, t } from "elysia";
import { loadAuthConfig } from "./lib/auth/config.ts";
import {
  buildAuthorizeUrl,
  completeLogin,
  createPkce,
  randomToken,
} from "./lib/auth/oidc.ts";
import type { Session } from "./lib/auth/session.ts";
import {
  signSession,
  signTransaction,
  verifySession,
  verifyTransaction,
} from "./lib/auth/session.ts";
import { getDb, runMigrations } from "./lib/db/client.ts";
import {
  addSignerToDraft,
  createDraft,
  createMultiSignerRequest,
  deleteOwnedDocument,
  getEditorData,
  getSignedPdf,
  getSignedPdfForMember,
  getSignedPdfForSignToken,
  getSignerFillData,
  getStatus,
  listWorkspaceDocuments,
  removeSignerFromDraft,
  saveFields,
  sendDraft,
  sendOwnedDraft,
  signByToken,
  updateDraftSigner,
  voidDocument,
} from "./lib/documents/documentService.ts";
import {
  createDraftFromTemplate,
  listTemplates,
  saveTemplateFromDraft,
} from "./lib/documents/templateService.ts";
import { sendSignatureRequestEmail } from "./lib/email/signatureRequestEmail.ts";
import { runReminders } from "./lib/reminders/reminderJob.ts";
import { signPdf } from "./lib/signing/pdfSigner.ts";
import { loadServiceSigner } from "./lib/signing/signerIdentity.ts";
import { pdfStorageEnabled } from "./lib/storage/pdfStore.ts";
import { editorPage } from "./lib/ui/editorPage.ts";
import {
  authBar,
  dashboardPage,
  landingPage,
  notFoundPage,
} from "./lib/ui/pages.ts";
import { signerFillPage } from "./lib/ui/signerFillPage.ts";

// pdf.js browser build, served to the editor from the service (no CDN)
const requireFile = createRequire(import.meta.url);
const PDFJS_MAIN = requireFile.resolve("pdfjs-dist/build/pdf.min.mjs");
const PDFJS_WORKER = requireFile.resolve("pdfjs-dist/build/pdf.worker.min.mjs");
const js = (path: string) =>
  new Response(Bun.file(path), {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });

// the public Omni Signing Root CA, published so verifiers can trust the chain
const ROOT_CA_PATH = requireFile.resolve("../certs/omni-signing-root-ca.pem");

const signer = loadServiceSigner();
const port = Number(process.env.PORT ?? 3000);
const baseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
// Signer links are hosted by the signet-app front end (a clean, native page on
// the app origin) rather than this API's own host. Falls back to the API when
// unset, so the API still works standalone
const appBaseUrl = process.env.SIGNET_APP_URL ?? baseUrl;
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

const SERVICE_KEY = process.env.SIGNET_SERVICE_KEY;

const app = new Elysia()
  // Resolve the signed-in sender. The signet-app front end proxies signed-in
  // requests server-to-server with no cookie, passing the user's identity in
  // headers authenticated by a shared service key; everything else reads the
  // session cookie as before
  .derive(async ({ cookie, headers }) => {
    const ownerId = headers["x-signet-owner-id"];
    if (
      SERVICE_KEY &&
      headers["x-signet-service-key"] === SERVICE_KEY &&
      ownerId
    ) {
      const organizationId = headers["x-signet-organization-id"] || undefined;
      const session: Session = {
        sub: ownerId,
        email: headers["x-signet-owner-email"] ?? "",
        organizationId,
        workspaces: organizationId ? [{ id: organizationId }] : undefined,
      };
      return { session };
    }
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
    objectStorage: pdfStorageEnabled(),
  }))
  // pdf.js assets for the editor
  // the Omni Signing Root CA (PEM), so verifiers can trust Signet's chain
  .get(
    "/omni-signing-root-ca.pem",
    () =>
      new Response(Bun.file(ROOT_CA_PATH), {
        headers: {
          "content-type": "application/x-pem-file",
          "cache-control": "public, max-age=86400",
        },
      }),
  )
  .get("/assets/pdf/pdf.min.mjs", () => js(PDFJS_MAIN))
  .get("/assets/pdf/pdf.worker.min.mjs", () => js(PDFJS_WORKER))
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

  // periodically remind signers with a document waiting on them
  const reminderHours = Number(process.env.SIGNET_REMINDER_HOURS ?? 24);
  if (reminderHours > 0) {
    const intervalMs = reminderHours * 60 * 60 * 1000;
    const sweep = () =>
      runReminders(db, appBaseUrl, intervalMs, sendSignatureRequestEmail).catch(
        (err) => console.warn("[signet] reminder sweep failed", err),
      );
    setInterval(sweep, 60 * 60 * 1000).unref();
  } else {
    console.warn("SIGNET_REMINDER_HOURS=0, signer reminders disabled");
  }

  app
    // the signed-in sender's documents (scoped to their active workspace), so
    // the app can show a "Your documents" list instead of stranding uploads
    .get("/api/documents", async ({ session, set }) => {
      if (!session) {
        set.status = 401;
        return { documents: [] };
      }
      const documents = await listWorkspaceDocuments(
        db,
        session.sub,
        session.organizationId,
      );
      return { documents };
    })
    // create a signing request, returns shareable links
    .post(
      "/api/documents",
      async ({ body, session, set }) => {
        const pdf = new Uint8Array(await body.file.arrayBuffer());
        const documentName = body.name || body.file.name || "Document";

        // Multi-signer send: a JSON `signers` array ([{name,email?}]) takes
        // precedence. Each party is auto-assigned their own signing line and
        // emailed their link (sequential sends email only the first signer now)
        let parsedSigners: { name: string; email?: string }[] = [];
        if (body.signers) {
          try {
            parsedSigners = (
              JSON.parse(body.signers) as { name?: string; email?: string }[]
            )
              .map((s) => ({
                name: (s.name ?? "").trim(),
                email: s.email?.trim() || undefined,
              }))
              .filter((s) => s.name);
          } catch {
            parsedSigners = [];
          }
        }
        if (parsedSigners.length === 0 && body.signerName) {
          parsedSigners = [
            { name: body.signerName, email: body.signerEmail || undefined },
          ];
        }
        if (parsedSigners.length === 0) {
          set.status = 400;
          return { error: "no_signers" };
        }

        const sequential = body.signingMode === "sequential";
        // save without sending when the caller asks to (a draft); drafts are
        // owner-only, so ignore the flag for an anonymous sender
        const draft = body.draft === "true" && Boolean(session?.sub);
        const req = await createMultiSignerRequest(db, {
          name: documentName,
          pdf,
          signers: parsedSigners,
          signingMode: sequential ? "sequential" : "parallel",
          draft,
          ownerId: session?.sub,
          organizationId: session?.organizationId,
          ownerEmail: session?.email,
        });

        // email each signer their link unless this is a draft; in sequential
        // mode only the first is notified now, the rest as each predecessor
        // finishes (see signByToken)
        if (!draft) {
          const toNotify = sequential ? req.signers.slice(0, 1) : req.signers;
          for (const s of toNotify) {
            if (!s.email) continue;
            await sendSignatureRequestEmail({
              to: s.email,
              signerName: s.name,
              documentName,
              signUrl: `${appBaseUrl}/sign/${s.signToken}`,
            });
          }
        }

        const first = req.signers[0];
        set.status = 201;
        return {
          id: req.id,
          draft,
          // the first signer's link, for the "share this link" affordance
          signUrl: first ? `${appBaseUrl}/sign/${first.signToken}` : undefined,
          signers: req.signers.map((s) => ({
            name: s.name,
            signUrl: `${appBaseUrl}/sign/${s.signToken}`,
          })),
          manageUrl: `${baseUrl}/d/${req.id}?token=${req.manageToken}`,
        };
      },
      {
        body: t.Object({
          file: t.File({ type: "application/pdf" }),
          name: t.Optional(t.String()),
          // legacy single-signer fields (kept for back-compat)
          signerName: t.Optional(t.String()),
          signerEmail: t.Optional(t.String()),
          // preferred: a JSON array of { name, email? }
          signers: t.Optional(t.String()),
          signingMode: t.Optional(t.String()),
          // "true" to save as an unsent draft instead of sending now
          draft: t.Optional(t.String()),
        }),
      },
    )
    // send a draft the signed-in owner owns, returning each signer's link
    .post("/api/documents/:id/send", async ({ params, session, set }) => {
      if (!session) {
        set.status = 401;
        return { ok: false };
      }
      const result = await sendOwnedDraft(
        db,
        params.id,
        session.sub,
        (session.workspaces ?? []).map((w) => w.id),
      );
      if (!result) {
        set.status = 404;
        return { ok: false };
      }
      for (const s of result.signers) {
        if (s.active && s.email) {
          await sendSignatureRequestEmail({
            to: s.email,
            signerName: s.name,
            documentName: result.documentName,
            signUrl: `${appBaseUrl}/sign/${s.signToken}`,
          });
        }
      }
      return {
        ok: true,
        signers: result.signers.map((s) => ({
          name: s.name,
          signUrl: `${appBaseUrl}/sign/${s.signToken}`,
        })),
      };
    })
    // delete a document the signed-in owner owns (draft or sent)
    .delete("/api/documents/:id", async ({ params, session, set }) => {
      if (!session) {
        set.status = 401;
        return { ok: false };
      }
      const ok = await deleteOwnedDocument(
        db,
        params.id,
        session.sub,
        (session.workspaces ?? []).map((w) => w.id),
      );
      if (!ok) {
        set.status = 404;
        return { ok: false };
      }
      return { ok: true };
    })
    // create a draft for the field-placement editor (one or more signers)
    .post(
      "/api/drafts",
      async ({ body, session, set }) => {
        const pdf = new Uint8Array(await body.file.arrayBuffer());
        const documentName = body.name || body.file.name || "Document";
        let signers: { name: string; email?: string }[] = [];
        try {
          const parsed = JSON.parse(body.signers) as {
            name?: string;
            email?: string;
          }[];
          signers = parsed
            .filter((s) => s.name?.trim())
            .map((s) => ({
              name: s.name as string,
              email: s.email || undefined,
            }));
        } catch {
          signers = [];
        }
        if (signers.length === 0) {
          set.status = 400;
          return { error: "at_least_one_signer" };
        }
        const draft = await createDraft(db, {
          name: documentName,
          pdf,
          signers,
          signingMode:
            body.signingMode === "sequential" ? "sequential" : "parallel",
          ownerId: session?.sub,
          organizationId: session?.organizationId,
          ownerEmail: session?.email,
        });
        set.status = 201;
        return {
          id: draft.id,
          editUrl: `${baseUrl}/d/${draft.id}/edit?token=${draft.manageToken}`,
        };
      },
      {
        body: t.Object({
          file: t.File({ type: "application/pdf" }),
          name: t.Optional(t.String()),
          signers: t.String(),
          signingMode: t.Optional(t.String()),
        }),
      },
    )
    // the field-placement editor
    .get("/d/:id/edit", async ({ params, query }) => {
      const data = await getEditorData(db, params.id, query.token ?? "");
      if (!data) return html(notFoundPage());
      return html(editorPage(data, query.token ?? ""));
    })
    // save the editor's field set
    .post(
      "/d/:id/fields",
      async ({ params, query, body, set }) => {
        const ok = await saveFields(
          db,
          params.id,
          query.token ?? "",
          body.fields,
        );
        if (!ok) {
          set.status = 404;
          return { ok: false };
        }
        return { ok: true };
      },
      {
        body: t.Object({
          fields: t.Array(
            t.Object({
              signerId: t.Union([t.String(), t.Null()]),
              type: t.String(),
              page: t.Integer(),
              x: t.Number(),
              y: t.Number(),
              width: t.Number(),
              height: t.Number(),
            }),
          ),
        }),
      },
    )
    // send a draft: mark sent and email each signer their link
    .post("/d/:id/send", async ({ params, query, set }) => {
      const result = await sendDraft(db, params.id, query.token ?? "");
      if (!result) {
        set.status = 404;
        return { ok: false };
      }
      const signers = result.signers.map((s) => {
        const signUrl = `${appBaseUrl}/sign/${s.signToken}`;
        // in sequential mode only the active (first) signer is emailed now
        if (s.email && s.active) {
          void sendSignatureRequestEmail({
            to: s.email,
            signerName: s.name,
            documentName: result.documentName,
            signUrl,
          });
        }
        return { name: s.name, signUrl, active: s.active };
      });
      return { ok: true, signers };
    })
    // add a signer to a draft (draft only)
    .post(
      "/d/:id/signers",
      async ({ params, query, body, set }) => {
        const added = await addSignerToDraft(db, params.id, query.token ?? "", {
          name: body.name,
          email: body.email,
        });
        if (!added) {
          set.status = 400;
          return { ok: false, error: "not_a_draft_or_invalid" };
        }
        return { ok: true, signer: added };
      },
      { body: t.Object({ name: t.String(), email: t.Optional(t.String()) }) },
    )
    // update a draft signer's name/email (draft only)
    .patch(
      "/d/:id/signers/:signerId",
      async ({ params, query, body, set }) => {
        const ok = await updateDraftSigner(
          db,
          params.id,
          query.token ?? "",
          params.signerId,
          { name: body.name, email: body.email },
        );
        if (!ok) {
          set.status = 400;
          return { ok: false, error: "not_a_draft_or_not_found" };
        }
        return { ok: true };
      },
      {
        body: t.Object({
          name: t.Optional(t.String()),
          email: t.Optional(t.String()),
        }),
      },
    )
    // remove a signer from a draft (draft only, never the last one)
    .delete("/d/:id/signers/:signerId", async ({ params, query, set }) => {
      const ok = await removeSignerFromDraft(
        db,
        params.id,
        query.token ?? "",
        params.signerId,
      );
      if (!ok) {
        set.status = 400;
        return { ok: false, error: "not_a_draft_or_last_signer" };
      }
      return { ok: true };
    })
    // save the draft's document + field layout as a reusable template
    .post("/d/:id/template", async ({ params, query, set }) => {
      const result = await saveTemplateFromDraft(
        db,
        params.id,
        query.token ?? "",
      );
      if (!result) {
        set.status = 400;
        return { ok: false, error: "sign_in_required" };
      }
      return { ok: true, id: result.id };
    })
    // signer fill data as JSON, for the native signer page on the app origin
    .get("/api/sign/:token", async ({ params, set }) => {
      const data = await getSignerFillData(db, params.token);
      if (!data) {
        set.status = 404;
        return { error: "not_found" };
      }
      return data;
    })
    // signer-facing fill overlay
    .get("/sign/:token", async ({ params }) => {
      const data = await getSignerFillData(db, params.token);
      if (!data) return html(notFoundPage());
      return html(signerFillPage(data, params.token));
    })
    // signer applies their signature (typed name, drawn image, text fields)
    .post(
      "/sign/:token",
      async ({ params, body, set }) => {
        const result = await signByToken(
          db,
          signer,
          params.token,
          body?.signature,
          {
            signatureImage: body?.signatureImage ?? null,
            textValues: body?.textValues ?? {},
          },
        );
        if (!result.ok) {
          set.status = result.error === "not_found" ? 404 : 409;
          return { ok: false, error: result.error };
        }
        // sequential routing: hand off to the next signer by email
        if (result.notifySigner?.email) {
          void sendSignatureRequestEmail({
            to: result.notifySigner.email,
            signerName: result.notifySigner.name,
            documentName: result.notifySigner.documentName,
            signUrl: `${appBaseUrl}/sign/${result.notifySigner.signToken}`,
          });
        }
        return { ok: true, completed: result.completed };
      },
      {
        body: t.Optional(
          t.Object({
            signature: t.Optional(t.String()),
            signatureImage: t.Optional(t.Union([t.String(), t.Null()])),
            textValues: t.Optional(t.Record(t.String(), t.String())),
          }),
        ),
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
      // the dashboard: documents (scoped to the active workspace) and templates
      .get("/dashboard", async ({ session, set }) => {
        if (!session) {
          set.status = 302;
          set.headers.location = "/login";
          return null;
        }
        const [docs, templates] = await Promise.all([
          listWorkspaceDocuments(db, session.sub, session.organizationId),
          listTemplates(db, session.sub),
        ]);
        return html(
          dashboardPage(session.email, docs, templates, {
            workspaces: session.workspaces ?? [],
            activeId: session.organizationId,
          }),
        );
      })
      // switch the active workspace (must be one the sender belongs to)
      .post(
        "/workspace/switch",
        async ({ session, body, cookie, set }) => {
          if (!session || !authConfig) {
            set.status = 401;
            return { ok: false };
          }
          const member = (session.workspaces ?? []).some(
            (w) => w.id === body.workspaceId,
          );
          if (!member) {
            set.status = 400;
            return { ok: false, error: "not_a_member" };
          }
          const token = await signSession(
            { ...session, organizationId: body.workspaceId },
            authConfig.sessionSecret,
          );
          cookie[SESSION_COOKIE]?.set({
            value: token,
            httpOnly: true,
            secure: secureCookies,
            sameSite: "lax",
            path: "/",
            maxAge: SESSION_MAX_AGE,
          });
          set.status = 302;
          set.headers.location = "/dashboard";
          return null;
        },
        { body: t.Object({ workspaceId: t.String() }) },
      )
      // download a signed document, authorized by ownership or workspace membership
      .get("/dashboard/d/:id/signed", async ({ session, params, set }) => {
        if (!session) {
          set.status = 302;
          set.headers.location = "/login";
          return null;
        }
        const signed = await getSignedPdfForMember(
          db,
          params.id,
          session.sub,
          (session.workspaces ?? []).map((w) => w.id),
        );
        if (!signed) {
          set.status = 404;
          return { error: "not_available" };
        }
        return pdfResponse(signed, "signed.pdf");
      })
      // start a new draft from one of the owner's templates
      .post(
        "/api/drafts/from-template",
        async ({ session, body, set }) => {
          if (!session) {
            set.status = 401;
            return { ok: false };
          }
          let signers: { name: string; email?: string }[] = [];
          try {
            signers = (
              JSON.parse(body.signers) as { name?: string; email?: string }[]
            )
              .filter((s) => s.name?.trim())
              .map((s) => ({
                name: s.name as string,
                email: s.email || undefined,
              }));
          } catch {
            signers = [];
          }
          if (signers.length === 0) {
            set.status = 400;
            return { ok: false, error: "at_least_one_signer" };
          }
          const draft = await createDraftFromTemplate(
            db,
            body.templateId,
            session.sub,
            signers,
            session.email,
            session.organizationId,
          );
          if (!draft) {
            set.status = 404;
            return { ok: false };
          }
          return {
            ok: true,
            editUrl: `${baseUrl}/d/${draft.id}/edit?token=${draft.manageToken}`,
          };
        },
        {
          body: t.Object({
            templateId: t.String(),
            signers: t.String(),
          }),
        },
      );
  }
}

app.listen(port);

console.info(`Signet listening on ${baseUrl}`);
if (signer.ephemeral) {
  console.warn(
    "signing with an ephemeral identity, signatures will show an unknown issuer",
  );
}
