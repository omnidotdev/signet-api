import { Elysia, t } from "elysia";
import { signPdf } from "./lib/signing/pdfSigner.ts";
import { loadServiceSigner } from "./lib/signing/signerIdentity.ts";

const signer = loadServiceSigner();
const port = Number(process.env.PORT ?? 3000);

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Signet</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: #faf7f2; color: #1c1917; }
  main { max-width: 560px; margin: 0 auto; padding: 48px 20px; }
  h1 { font-size: 28px; margin: 0 0 4px; }
  p.sub { margin: 0 0 32px; color: #78716c; }
  form { display: grid; gap: 16px; background: #fff; border: 1px solid #e7e2da; border-radius: 14px; padding: 24px; }
  label { font-weight: 600; font-size: 13px; display: block; margin-bottom: 6px; }
  input[type=text], input[type=file] { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #d6cfc4; border-radius: 9px; background: #fff; font: inherit; }
  button { padding: 12px 16px; border: 0; border-radius: 9px; background: #b45309; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  .note { font-size: 12px; color: #a8a29e; margin-top: 24px; text-align: center; }
  @media (prefers-color-scheme: dark) {
    body { background: #1c1917; color: #f5f5f4; }
    form { background: #292524; border-color: #44403c; }
    input[type=text], input[type=file] { background: #1c1917; border-color: #57534e; color: #f5f5f4; }
    p.sub { color: #a8a29e; }
  }
</style>
</head>
<body>
<main>
  <h1>Signet</h1>
  <p class="sub">Sign a PDF with a verifiable digital signature.</p>
  <form id="f">
    <div>
      <label for="file">PDF document</label>
      <input id="file" name="file" type="file" accept="application/pdf" required />
    </div>
    <div>
      <label for="name">Signer name</label>
      <input id="name" name="name" type="text" placeholder="Jane Doe" />
    </div>
    <div>
      <label for="reason">Reason</label>
      <input id="reason" name="reason" type="text" placeholder="I agree to the terms" />
    </div>
    <button id="btn" type="submit">Sign document</button>
  </form>
  <p class="note">Signed documents verify in any standards-compliant PDF reader.</p>
</main>
<script>
  const f = document.getElementById("f");
  const btn = document.getElementById("btn");
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = "Signing...";
    try {
      const res = await fetch("/api/sign", { method: "POST", body: new FormData(f) });
      if (!res.ok) throw new Error("Signing failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "signed.pdf";
      a.click();
      URL.revokeObjectURL(url);
      btn.textContent = "Signed, downloaded";
    } catch (err) {
      btn.textContent = "Error, try again";
    } finally {
      setTimeout(() => { btn.disabled = false; btn.textContent = "Sign document"; }, 1500);
    }
  });
</script>
</body>
</html>`;

export const app = new Elysia()
  .get("/", () => new Response(page, { headers: { "content-type": "text/html" } }))
  .get("/health", () => ({ status: "ok", signer: signer.commonName }))
  .post(
    "/api/sign",
    async ({ body, set }) => {
      const input = new Uint8Array(await body.file.arrayBuffer());
      const signed = await signPdf(input, signer.pkcs12, {
        name: body.name || signer.commonName,
        reason: body.reason || "Signed with Signet",
        passphrase: signer.passphrase,
      });
      set.headers["content-type"] = "application/pdf";
      set.headers["content-disposition"] = 'attachment; filename="signed.pdf"';
      return new Response(signed);
    },
    {
      body: t.Object({
        file: t.File({ type: "application/pdf" }),
        name: t.Optional(t.String()),
        reason: t.Optional(t.String()),
      }),
    },
  )
  .listen(port);

console.log(`Signet listening on http://localhost:${port}`);
if (signer.ephemeral) {
  console.warn(
    "signing with an ephemeral identity, signatures will show an unknown issuer",
  );
}
