import type { EditorData } from "../documents/documentService.ts";
import { shell } from "./pages.ts";

/**
 * The field-placement editor: renders the PDF in the browser with pdf.js, lets
 * the sender drag, resize, add, delete, and assign fields to signers, then save
 * and send. All state is injected as JSON; the heavy lifting is the client
 * script below.
 */
export const editorPage = (data: EditorData, manageToken: string): string => {
  const payload = JSON.stringify({ ...data, manageToken }).replace(
    /</g,
    "\\u003c",
  );
  return shell(
    `Prepare: ${data.name}`,
    `<div class="authbar"><a href="/">Signet</a></div>
<h1>Prepare "${escapeHtml(data.name)}"</h1>
<p class="sub">Add fields and drag them where each signer should sign. Pick a signer, then click a field type to drop it on the page.</p>

<div class="toolbar">
  <label for="signer-pick">Signer</label>
  <select id="signer-pick"></select>
  <span class="spacer"></span>
  <button type="button" data-add="signature">+ Signature</button>
  <button type="button" data-add="initials">+ Initials</button>
  <button type="button" data-add="date">+ Date</button>
  <button type="button" data-add="text">+ Text</button>
  <span class="spacer"></span>
  <button type="button" id="save-btn" class="ghost">Save</button>
  <button type="button" id="tpl-btn" class="ghost">Save as template</button>
  <button type="button" id="send-btn">Send for signature</button>
</div>
<p id="editor-status" class="note"></p>

<div id="pages"></div>
<div id="sent-panel" hidden></div>

<style>
  .toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; position: sticky; top: 0; background: var(--bg-canvas); padding: 12px 0; z-index: 5; border-bottom: 1px solid var(--border-subtle); }
  .toolbar .spacer { flex: 0 0 8px; }
  .toolbar button { padding: 8px 12px; font-size: 0.8125rem; }
  .toolbar select { padding: 8px 10px; border: 1px solid var(--border-muted); border-radius: var(--radius-lg); background: var(--bg-default); color: var(--fg-default); font: inherit; }
  .page-wrap { position: relative; margin: 16px auto; box-shadow: 0 1px 4px rgba(0,0,0,.15); width: fit-content; }
  .page-wrap canvas { display: block; }
  .overlay { position: absolute; inset: 0; }
  .fld { position: absolute; border: 1.5px solid; border-radius: 4px; background: rgba(0,0,0,.04); cursor: move; font-size: 11px; font-weight: 600; overflow: hidden; user-select: none; }
  .fld .lbl { padding: 1px 4px; color: #fff; white-space: nowrap; }
  .fld .del { position: absolute; top: -9px; right: -9px; width: 18px; height: 18px; border-radius: 50%; border: 0; background: #b03a4a; color: #fff; font-size: 12px; line-height: 1; cursor: pointer; padding: 0; }
  .fld .rsz { position: absolute; right: -5px; bottom: -5px; width: 12px; height: 12px; background: #fff; border: 1.5px solid currentColor; border-radius: 2px; cursor: nwse-resize; }
  #sent-panel { margin-top: 16px; }
  #sent-panel .share { margin-top: 6px; }
</style>

<script type="application/json" id="editor-data">${payload}</script>
<script type="module">
import * as pdfjs from "/assets/pdf/pdf.min.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "/assets/pdf/pdf.worker.min.mjs";

const DATA = JSON.parse(document.getElementById("editor-data").textContent);
const statusEl = document.getElementById("editor-status");
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

const SCALE = 1.25;
const pageHeights = {};   // page number -> PDF points height
let fields = DATA.fields.map((f) => ({ ...f, key: f.id || crypto.randomUUID() }));
const colorOf = (signerId) => DATA.signers.find((s) => s.id === signerId)?.color || "#be6221";
const typeLabel = { signature: "Signature", initials: "Initials", date: "Date", text: "Text" };

// signer picker
const pick = document.getElementById("signer-pick");
for (const s of DATA.signers) {
  const o = document.createElement("option");
  o.value = s.id; o.textContent = s.name;
  pick.appendChild(o);
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
    wrap.className = "page-wrap"; wrap.dataset.page = p;
    wrap.style.width = viewport.width + "px"; wrap.style.height = viewport.height + "px";
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width; canvas.height = viewport.height;
    const overlay = document.createElement("div");
    overlay.className = "overlay"; overlay.dataset.page = p;
    wrap.append(canvas, overlay); host.appendChild(wrap);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  }
  drawFields();
}

// store -> screen
function place(el, f) {
  const h = pageHeights[f.page] || 792;
  el.style.left = (f.x * SCALE) + "px";
  el.style.top = ((h - f.y - f.height) * SCALE) + "px";
  el.style.width = (f.width * SCALE) + "px";
  el.style.height = (f.height * SCALE) + "px";
}

function drawFields() {
  for (const ov of document.querySelectorAll(".overlay")) ov.textContent = "";
  for (const f of fields) {
    const ov = document.querySelector('.overlay[data-page="' + f.page + '"]');
    if (!ov) continue;
    const el = document.createElement("div");
    el.className = "fld"; el.style.color = colorOf(f.signerId); el.style.borderColor = colorOf(f.signerId);
    el.innerHTML = '<span class="lbl" style="background:' + colorOf(f.signerId) + '">' + typeLabel[f.type] + '</span><button class="del" title="Remove">\\u00d7</button><span class="rsz"></span>';
    place(el, f);
    wireField(el, f);
    ov.appendChild(el);
  }
}

function toStore(el, f) {
  const ov = el.parentElement;
  const h = pageHeights[f.page] || 792;
  f.x = el.offsetLeft / SCALE;
  f.width = el.offsetWidth / SCALE;
  f.height = el.offsetHeight / SCALE;
  f.y = h - (el.offsetTop / SCALE) - f.height;
  f.x = Math.max(0, f.x); f.y = Math.max(0, f.y);
}

function wireField(el, f) {
  el.querySelector(".del").addEventListener("click", (e) => {
    e.stopPropagation();
    fields = fields.filter((x) => x.key !== f.key);
    el.remove();
  });
  const rsz = el.querySelector(".rsz");
  rsz.addEventListener("pointerdown", (e) => {
    e.preventDefault(); e.stopPropagation();
    const sx = e.clientX, sy = e.clientY, sw = el.offsetWidth, sh = el.offsetHeight;
    const move = (ev) => {
      el.style.width = Math.max(40, sw + ev.clientX - sx) + "px";
      el.style.height = Math.max(14, sh + ev.clientY - sy) + "px";
    };
    const up = () => { toStore(el, f); document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
  });
  el.addEventListener("pointerdown", (e) => {
    if (e.target.classList.contains("del") || e.target.classList.contains("rsz")) return;
    e.preventDefault();
    const ox = e.clientX - el.offsetLeft, oy = e.clientY - el.offsetTop;
    const ov = el.parentElement;
    const move = (ev) => {
      el.style.left = Math.max(0, Math.min(ov.clientWidth - el.offsetWidth, ev.clientX - ox)) + "px";
      el.style.top = Math.max(0, Math.min(ov.clientHeight - el.offsetHeight, ev.clientY - oy)) + "px";
    };
    const up = () => { toStore(el, f); document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
  });
}

// add a field to the top of page 1 for the chosen signer
for (const btn of document.querySelectorAll("[data-add]")) {
  btn.addEventListener("click", () => {
    const h = pageHeights[1] || 792;
    const f = { key: crypto.randomUUID(), signerId: pick.value, type: btn.dataset.add, page: 1, x: 72, y: h - 140, width: btn.dataset.add === "date" ? 90 : 160, height: 18 };
    fields.push(f);
    drawFields();
  });
}

async function save() {
  statusEl.textContent = "Saving...";
  const payload = fields.map(({ signerId, type, page, x, y, width, height }) => ({ signerId, type, page, x, y, width, height }));
  const res = await fetch("/d/" + DATA.id + "/fields?token=" + encodeURIComponent(DATA.manageToken), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fields: payload }),
  });
  statusEl.textContent = res.ok ? "Saved." : "Save failed.";
  return res.ok;
}
document.getElementById("save-btn").addEventListener("click", save);

document.getElementById("tpl-btn").addEventListener("click", async () => {
  if (!(await save())) return;
  const res = await fetch("/d/" + DATA.id + "/template?token=" + encodeURIComponent(DATA.manageToken), { method: "POST" });
  const out = await res.json().catch(() => ({}));
  statusEl.textContent = res.ok ? "Saved as a template; find it on your dashboard." : (out.error === "sign_in_required" ? "Sign in to save templates." : "Could not save template.");
});

document.getElementById("send-btn").addEventListener("click", async () => {
  if (!(await save())) return;
  statusEl.textContent = "Sending...";
  const res = await fetch("/d/" + DATA.id + "/send?token=" + encodeURIComponent(DATA.manageToken), { method: "POST" });
  if (!res.ok) { statusEl.textContent = "Send failed."; return; }
  const out = await res.json();
  const panel = document.getElementById("sent-panel");
  panel.hidden = false;
  panel.innerHTML = '<div class="card"><h2>Sent</h2><p class="note">Share each signer\\u2019s link:</p>' +
    out.signers.map((s) => '<p class="note">' + s.name + '</p><div class="share">' + s.signUrl + '</div>').join("") + '</div>';
  document.querySelector(".toolbar").hidden = true;
  statusEl.textContent = "";
  panel.scrollIntoView({ behavior: "smooth" });
});

render().catch((e) => { statusEl.textContent = "Could not render the document."; console.error(e); });
</script>`,
  );
};

/** Minimal HTML escape for attribute/text interpolation */
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
