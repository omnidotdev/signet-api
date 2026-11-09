const STYLE = `
  :root { color-scheme: light dark; --accent: #b45309; --bg: #faf7f2; --fg: #1c1917; --card: #fff; --border: #e7e2da; --muted: #78716c; --field: #fff; --fieldBorder: #d6cfc4; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1c1917; --fg: #f5f5f4; --card: #292524; --border: #44403c; --muted: #a8a29e; --field: #1c1917; --fieldBorder: #57534e; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 600px; margin: 0 auto; padding: 48px 20px; }
  h1 { font-size: 28px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 32px 0 12px; }
  p.sub { margin: 0 0 8px; color: var(--muted); }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 24px; margin-top: 16px; }
  form { display: grid; gap: 16px; }
  label { font-weight: 600; font-size: 13px; display: block; margin-bottom: 6px; }
  input[type=text], input[type=email], input[type=file] { width: 100%; padding: 10px 12px; border: 1px solid var(--fieldBorder); border-radius: 9px; background: var(--field); font: inherit; color: var(--fg); }
  button { padding: 12px 16px; border: 0; border-radius: 9px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  button.ghost { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
  button:disabled { opacity: .6; cursor: default; }
  a { color: var(--accent); }
  .note { font-size: 12px; color: var(--muted); margin-top: 8px; }
  .share { font-family: ui-monospace, monospace; font-size: 13px; word-break: break-all; background: var(--bg); border: 1px solid var(--border); border-radius: 9px; padding: 10px 12px; margin-top: 8px; }
  .pill { display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 10px; border-radius: 999px; background: var(--accent); color: #fff; }
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
