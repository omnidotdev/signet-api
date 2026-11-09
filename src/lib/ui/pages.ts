// Sigil design tokens (semantic colors, radii, type scale) from
// @omnidotdev/sigil-tokens, inlined as CSS custom properties. This service
// renders plain HTML (no Tailwind build), so the token values are mirrored here
// rather than imported. The accent is Sigil's citrine scale, the fabric-realm
// amber Signet shares with its sibling products. Dark mode follows the viewer's
// prefers-color-scheme using Sigil's dark palette
const STYLE = `
  :root {
    color-scheme: light dark;
    --bg-canvas: #fdfdfd; --bg-default: #ffffff; --bg-subtle: #fafafa; --bg-muted: #f5f5f5;
    --fg-default: #0a0a0a; --fg-muted: #525252; --fg-subtle: #737373;
    --accent: #be6221; --accent-emphasized: #9e461f; --accent-fg: #ffffff;
    --border-muted: #a3a3a3; --border-subtle: #e5e5e5;
    --surface: var(--bg-default);
    --radius-lg: 0.5rem; --radius-xl: 0.75rem; --radius-2xl: 1rem; --radius-full: 9999px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg-canvas: #0a0a0a; --bg-default: #0a0a0a; --bg-subtle: #262626; --bg-muted: #262626;
      --fg-default: #ffffff; --fg-muted: #d4d4d4; --fg-subtle: #a3a3a3;
      --accent: #dfa040; --accent-emphasized: #d78129; --accent-fg: #0a0a0a;
      --border-muted: #737373; --border-subtle: #404040;
      --surface: var(--bg-subtle);
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 0.9375rem/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg-canvas); color: var(--fg-default); }
  main { max-width: 600px; margin: 0 auto; padding: 48px 20px; }
  h1 { font-size: 1.875rem; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 4px; }
  h2 { font-size: 1.125rem; font-weight: 600; margin: 32px 0 12px; }
  p.sub { margin: 0 0 8px; color: var(--fg-subtle); }
  .card { background: var(--surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-2xl); padding: 24px; margin-top: 16px; }
  form { display: grid; gap: 16px; }
  label { font-weight: 500; font-size: 0.8125rem; display: block; margin-bottom: 6px; color: var(--fg-muted); }
  input[type=text], input[type=email], input[type=file] { width: 100%; padding: 10px 12px; border: 1px solid var(--border-muted); border-radius: var(--radius-lg); background: var(--bg-default); font: inherit; color: var(--fg-default); }
  input:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button { padding: 12px 16px; border: 0; border-radius: var(--radius-lg); background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600; cursor: pointer; transition: background 0.15s ease; }
  button:hover:not(:disabled) { background: var(--accent-emphasized); }
  button.ghost { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
  button:disabled { opacity: .6; cursor: default; }
  a { color: var(--accent); }
  .note { font-size: 0.75rem; color: var(--fg-subtle); margin-top: 8px; }
  .share { font-family: ui-monospace, "SFMono-Regular", monospace; font-size: 0.8125rem; word-break: break-all; background: var(--bg-muted); border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); padding: 10px 12px; margin-top: 8px; }
  .pill { display: inline-block; font-size: 0.75rem; font-weight: 600; padding: 2px 10px; border-radius: var(--radius-full); background: var(--accent); color: var(--accent-fg); }
`;

/** Wrap page body in the shared document shell */
export const shell = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;

/** The landing page: quick-sign and send-for-signature */
export const landingPage = (): string =>
  shell(
    "Signet",
    `<h1>Signet</h1>
<p class="sub">Sign documents with a verifiable signature and provenance trail.</p>

<h2>Send for signature</h2>
<div class="card">
  <form id="send">
    <div><label for="s-file">PDF document</label><input id="s-file" name="file" type="file" accept="application/pdf" required /></div>
    <div><label for="s-name">Document name</label><input id="s-name" name="name" type="text" placeholder="Mutual NDA" /></div>
    <div><label for="s-signer">Signer name</label><input id="s-signer" name="signerName" type="text" placeholder="Jane Doe" required /></div>
    <div><label for="s-email">Signer email (optional)</label><input id="s-email" name="signerEmail" type="email" placeholder="jane@example.com" /></div>
    <button id="send-btn" type="submit">Create signing link</button>
  </form>
  <div id="send-result"></div>
</div>

<h2>Sign a PDF yourself</h2>
<div class="card">
  <form id="quick">
    <div><label for="q-file">PDF document</label><input id="q-file" name="file" type="file" accept="application/pdf" required /></div>
    <div><label for="q-name">Signer name</label><input id="q-name" name="name" type="text" placeholder="Your name" /></div>
    <button id="quick-btn" type="submit">Sign and download</button>
  </form>
</div>

<script>
  const send = document.getElementById("send");
  const sendResult = document.getElementById("send-result");
  send.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("send-btn");
    btn.disabled = true; btn.textContent = "Creating...";
    try {
      const res = await fetch("/api/documents", { method: "POST", body: new FormData(send) });
      if (!res.ok) throw new Error();
      const data = await res.json();
      sendResult.innerHTML = '<p class="note">Share this link with the signer:</p><div class="share">' + data.signUrl + '</div><p class="note">Track status: <a href="' + data.manageUrl + '">' + data.manageUrl + '</a></p>';
      btn.textContent = "Created";
    } catch { btn.textContent = "Error, try again"; }
    finally { setTimeout(() => { btn.disabled = false; btn.textContent = "Create signing link"; }, 1500); }
  });

  const quick = document.getElementById("quick");
  quick.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("quick-btn");
    btn.disabled = true; btn.textContent = "Signing...";
    try {
      const res = await fetch("/api/sign", { method: "POST", body: new FormData(quick) });
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = "signed.pdf"; a.click();
      URL.revokeObjectURL(url);
      btn.textContent = "Signed, downloaded";
    } catch { btn.textContent = "Error, try again"; }
    finally { setTimeout(() => { btn.disabled = false; btn.textContent = "Sign and download"; }, 1500); }
  });
</script>`,
  );

/** The signer-facing page for a pending signing request */
export const signerPage = (
  token: string,
  documentName: string,
  signerName: string,
  alreadySigned: boolean,
): string =>
  shell(
    `Sign: ${documentName}`,
    `<h1>${documentName}</h1>
<p class="sub">${signerName}, you have been asked to sign this document.</p>
<div class="card">
${
  alreadySigned
    ? `<p><span class="pill">Signed</span></p><p class="note">This document has been signed.</p>
       <a href="/sign/${token}/download"><button>Download signed PDF</button></a>`
    : `<form id="sign" method="post" action="/sign/${token}">
         <p>By clicking Sign, you apply your verifiable electronic signature to this document.</p>
         <button id="sign-btn" type="submit">Sign document</button>
       </form>
       <div id="sign-result"></div>
       <script>
         const f = document.getElementById("sign");
         f.addEventListener("submit", async (e) => {
           e.preventDefault();
           const btn = document.getElementById("sign-btn");
           btn.disabled = true; btn.textContent = "Signing...";
           try {
             const res = await fetch("/sign/${token}", { method: "POST" });
             if (!res.ok) throw new Error();
             document.getElementById("sign-result").innerHTML = '<p><span class="pill">Signed</span></p><a href="/sign/${token}/download"><button>Download signed PDF</button></a>';
             f.remove();
           } catch { btn.disabled = false; btn.textContent = "Error, try again"; }
         });
       </script>`
}
</div>`,
  );

/** Shown when a sign link is invalid or expired */
export const notFoundPage = (): string =>
  shell(
    "Not found",
    `<h1>Link not found</h1><p class="sub">This signing link is invalid, expired, or has been voided.</p>`,
  );
