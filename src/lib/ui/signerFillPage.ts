import type { SignerFillData } from "../documents/documentService.ts";
import { shell } from "./pages.ts";

/** Minimal HTML escape */
const esc = (v: string): string =>
  v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * The signer's fill page: renders the document with pdf.js and lets the signer
 * adopt a signature (typed or drawn), fill text fields in place, and sign. The
 * date fields fill automatically. When the document is already signed, it shows
 * the download instead.
 */
export const signerFillPage = (data: SignerFillData, token: string): string => {
  if (data.alreadySigned) {
    return shell(
      `Sign: ${esc(data.documentName)}`,
      `<div class="authbar"><a href="/">Signet</a></div>
<h1>${esc(data.documentName)}</h1>
<div class="card"><p><span class="pill">Signed</span></p>
<p class="note">Thank you, this document has your signature.</p>
<a href="/sign/${token}/download"><button>Download signed PDF</button></a></div>`,
    );
  }

  if (data.waitingFor) {
    return shell(
      `Sign: ${esc(data.documentName)}`,
      `<div class="authbar"><a href="/">Signet</a></div>
<h1>${esc(data.documentName)}</h1>
<div class="card"><p class="note">This document is signed in order, and it is not your turn yet. You will be emailed a link to sign once ${esc(data.waitingFor)} has signed.</p></div>`,
    );
  }

  const payload = JSON.stringify({ ...data, token }).replace(/</g, "\\u003c");
  return shell(
    `Sign: ${esc(data.documentName)}`,
    `<div class="authbar"><a href="/">Signet</a></div>
<h1>${esc(data.documentName)}</h1>
<p class="sub">${esc(data.signerName)}, review the document and sign where it is highlighted.</p>

<div class="card" id="adopt">
  <label>Adopt your signature</label>
  <div class="tabs">
    <button type="button" class="tab active" data-tab="type">Type</button>
    <button type="button" class="tab" data-tab="draw">Draw</button>
  </div>
  <div id="tab-type"><input id="sig-text" type="text" value="${esc(data.signerName)}" placeholder="Your full name" /></div>
  <div id="tab-draw" hidden>
    <canvas id="pad" width="420" height="120"></canvas>
    <div><button type="button" id="pad-clear" class="link">Clear</button></div>
  </div>
</div>

<div class="toolbar">
  <span id="sign-hint" class="note"></span>
  <span class="spacer"></span>
  <button type="button" id="finish-btn">Finish and sign</button>
</div>
<p id="sign-status" class="note"></p>

<div id="pages"></div>
<div id="done-panel" hidden></div>

<style>
  .tabs { display: flex; gap: 6px; margin-bottom: 10px; }
  .tab { padding: 6px 12px; font-size: 0.8125rem; background: var(--bg-muted); color: var(--fg-muted); }
  .tab.active { background: var(--accent); color: var(--accent-fg); }
  #pad { border: 1px dashed var(--border-muted); border-radius: var(--radius-lg); touch-action: none; background: var(--bg-default); max-width: 100%; }
  .page-wrap { position: relative; margin: 16px auto; box-shadow: 0 1px 4px rgba(0,0,0,.15); width: fit-content; }
  .page-wrap canvas { display: block; }
  .overlay { position: absolute; inset: 0; }
  .sfld { position: absolute; border: 1.5px solid var(--accent); border-radius: 4px; background: rgba(190,98,33,.08); display: flex; align-items: center; justify-content: center; overflow: hidden; cursor: pointer; }
  .sfld.filled { background: transparent; border-style: solid; }
  .sfld .ph { font-size: 10px; font-weight: 600; color: var(--accent); text-transform: uppercase; letter-spacing: .03em; }
  .sfld .sigtext { font-style: italic; font-weight: 600; color: #1c2e73; white-space: nowrap; }
  .sfld img { max-width: 100%; max-height: 100%; }
  .sfld input { width: 100%; height: 100%; border: 0; background: transparent; font: inherit; padding: 0 3px; color: #1c2e73; }
  .toolbar { position: sticky; top: 0; background: var(--bg-canvas); padding: 12px 0; display: flex; align-items: center; z-index: 5; border-bottom: 1px solid var(--border-subtle); }
  .toolbar .spacer { flex: 1; }
</style>

<script type="application/json" id="fill-data">${payload}</script>
<script type="module">
import * as pdfjs from "/assets/pdf/pdf.min.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "/assets/pdf/pdf.worker.min.mjs";

const DATA = JSON.parse(document.getElementById("fill-data").textContent);
const statusEl = document.getElementById("sign-status");
const hintEl = document.getElementById("sign-hint");
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const SCALE = 1.25;
const pageHeights = {};
const textValues = {};
let mode = "type";
let drawn = false;

const sigText = document.getElementById("sig-text");
const pad = document.getElementById("pad");
const pctx = pad.getContext("2d");
pctx.lineWidth = 2.5; pctx.lineCap = "round"; pctx.strokeStyle = "#1c2e73";

const sigCount = DATA.fields.filter((f) => f.type === "signature" || f.type === "initials").length;
hintEl.textContent = sigCount ? ("Sign in " + sigCount + " place" + (sigCount === 1 ? "" : "s") + "; dates fill in automatically.") : "Click Finish to apply your signature.";

// tabs
for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    mode = tab.dataset.tab;
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t === tab);
    document.getElementById("tab-type").hidden = mode !== "type";
    document.getElementById("tab-draw").hidden = mode !== "draw";
    renderPreviews();
  });
}
sigText.addEventListener("input", renderPreviews);

// remember the adopted signature on this device, so repeat signers reuse it
let savedSig = {};
try { savedSig = JSON.parse(localStorage.getItem("signet.sig") || "{}"); } catch {}
if (savedSig.name) sigText.value = savedSig.name;
if (savedSig.image) {
  const im = new Image();
  im.onload = () => { pctx.drawImage(im, 0, 0, pad.width, pad.height); drawn = true; renderPreviews(); };
  im.src = savedSig.image;
  const drawTab = document.querySelector('.tab[data-tab="draw"]');
  if (drawTab) drawTab.click();
}

// draw pad
let drawing = false, lastX = 0, lastY = 0;
const padPos = (e) => { const r = pad.getBoundingClientRect(); return [ (e.clientX - r.left) * (pad.width / r.width), (e.clientY - r.top) * (pad.height / r.height) ]; };
pad.addEventListener("pointerdown", (e) => { drawing = true; [lastX, lastY] = padPos(e); pad.setPointerCapture(e.pointerId); });
pad.addEventListener("pointermove", (e) => { if (!drawing) return; const [x, y] = padPos(e); pctx.beginPath(); pctx.moveTo(lastX, lastY); pctx.lineTo(x, y); pctx.stroke(); [lastX, lastY] = [x, y]; drawn = true; });
pad.addEventListener("pointerup", () => { drawing = false; renderPreviews(); });
document.getElementById("pad-clear").addEventListener("click", () => { pctx.clearRect(0, 0, pad.width, pad.height); drawn = false; renderPreviews(); });

const drawnDataUrl = () => (mode === "draw" && drawn ? pad.toDataURL("image/png") : null);
const today = new Date().toISOString().slice(0, 10);

function place(el, f) {
  const h = pageHeights[f.page] || 792;
  el.style.left = (f.x * SCALE) + "px";
  el.style.top = ((h - f.y - f.height) * SCALE) + "px";
  el.style.width = (f.width * SCALE) + "px";
  el.style.height = (f.height * SCALE) + "px";
}

async function render() {
  const pdf = await pdfjs.getDocument({ data: b64ToBytes(DATA.pdfBase64) }).promise;
  const host = document.getElementById("pages");
  host.textContent = "";
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: SCALE });
    pageHeights[p] = viewport.height / SCALE;
    const wrap = document.createElement("div");
    wrap.className = "page-wrap"; wrap.style.width = viewport.width + "px"; wrap.style.height = viewport.height + "px";
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width; canvas.height = viewport.height;
    const overlay = document.createElement("div");
    overlay.className = "overlay"; overlay.dataset.page = p;
    wrap.append(canvas, overlay); host.appendChild(wrap);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  }
  drawFields();
}

function drawFields() {
  for (const ov of document.querySelectorAll(".overlay")) ov.textContent = "";
  for (const f of DATA.fields) {
    const ov = document.querySelector('.overlay[data-page="' + f.page + '"]');
    if (!ov) continue;
    const el = document.createElement("div");
    el.className = "sfld"; el.dataset.fid = f.id; el.dataset.type = f.type;
    if (f.type === "date") {
      el.classList.add("filled");
      el.innerHTML = '<span class="sigtext">' + today + '</span>';
    } else if (f.type === "text") {
      const inp = document.createElement("input");
      inp.type = "text"; inp.placeholder = "Text";
      inp.value = textValues[f.id] || "";
      inp.addEventListener("input", () => { textValues[f.id] = inp.value; el.classList.toggle("filled", !!inp.value); });
      el.appendChild(inp);
    } else {
      el.innerHTML = '<span class="ph">' + (f.type === "initials" ? "Initials" : "Sign") + '</span>';
      el.addEventListener("click", () => document.getElementById("adopt").scrollIntoView({ behavior: "smooth", block: "center" }));
    }
    place(el, f);
    ov.appendChild(el);
  }
  renderPreviews();
}

function renderPreviews() {
  const img = drawnDataUrl();
  const name = sigText.value.trim();
  for (const el of document.querySelectorAll('.sfld[data-type="signature"], .sfld[data-type="initials"]')) {
    const isInitials = el.dataset.type === "initials";
    const mark = isInitials ? name.split(/\\s+/).filter(Boolean).map((p) => p[0] ? p[0].toUpperCase() : "").join("") : name;
    if (img) {
      el.innerHTML = '<img src="' + img + '" alt="signature" />';
      el.classList.add("filled");
    } else if (name) {
      el.innerHTML = '<span class="sigtext">' + mark.replace(/</g, "") + '</span>';
      el.classList.add("filled");
    } else {
      el.innerHTML = '<span class="ph">' + (isInitials ? "Initials" : "Sign") + '</span>';
      el.classList.remove("filled");
    }
  }
}

document.getElementById("finish-btn").addEventListener("click", async () => {
  const name = sigText.value.trim();
  const img = drawnDataUrl();
  if (sigCount > 0 && !name && !img) { statusEl.textContent = "Type or draw your signature first."; return; }
  const btn = document.getElementById("finish-btn");
  btn.disabled = true; btn.textContent = "Signing...";
  try {
    const body = { signature: name, signatureImage: img ? img.split(",")[1] : null, textValues };
    const res = await fetch("/sign/" + DATA.token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error();
    try { localStorage.setItem("signet.sig", JSON.stringify({ name, image: img || savedSig.image || null })); } catch {}
    const panel = document.getElementById("done-panel");
    panel.hidden = false;
    panel.innerHTML = '<div class="card"><p><span class="pill">Signed</span></p><a href="/sign/' + DATA.token + '/download"><button>Download signed PDF</button></a></div>';
    document.getElementById("adopt").hidden = true;
    document.querySelector(".toolbar").hidden = true;
    statusEl.textContent = "";
    panel.scrollIntoView({ behavior: "smooth" });
  } catch { btn.disabled = false; btn.textContent = "Finish and sign"; statusEl.textContent = "Something went wrong, try again."; }
});

render().catch((e) => { statusEl.textContent = "Could not render the document."; console.error(e); });
</script>`,
  );
};
