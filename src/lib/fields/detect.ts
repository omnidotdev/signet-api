/**
 * Auto-detect fillable fields (signature, date, initials) on an uploaded PDF by
 * reading its text with positions and matching common anchors ("Signature",
 * "Date", "Initials", "Sign here"). Positions are returned in PDF points with a
 * bottom-left origin, the same system pdf-lib stamps in.
 *
 * Best-effort: any extraction failure yields no fields, so a document that
 * cannot be parsed still signs (the whole-document signature always applies).
 */

export type FieldType = "signature" | "date" | "initials" | "text";

export interface DetectedField {
  type: FieldType;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

const SIGNATURE = /sign(?:ature|ed\s+by|\s+here)?\b/i;
const INITIALS = /\binitials?\b/i;
const DATE = /\bdate(?:d|\s+signed)?\b/i;
const UNDERSCORES = /_{3,}/;

/** Classify a text run into a field type, or null when it is not an anchor */
const classify = (str: string): FieldType | null => {
  if (INITIALS.test(str)) return "initials";
  if (SIGNATURE.test(str)) return "signature";
  if (DATE.test(str)) return "date";
  return null;
};

/**
 * Classify a blank by the nearest anchor label to its left on the same line,
 * for signature blocks that split the label and the blank into separate runs
 * ("Signature:" then "______"). Returns null when no label precedes the blank.
 */
const labelToLeft = (blank: TextItem, items: TextItem[]): FieldType | null => {
  const blankY = blank.transform[5] ?? 0;
  const blankX = blank.transform[4] ?? 0;
  let best: FieldType | null = null;
  let bestX = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    if (item === blank) continue;
    const y = item.transform[5] ?? 0;
    const x = item.transform[4] ?? 0;
    if (Math.abs(y - blankY) > 5) continue; // same line
    if (x >= blankX) continue; // to the left of the blank
    const type = classify(item.str);
    if (type && x > bestX) {
      best = type;
      bestX = x;
    }
  }
  return best;
};

/**
 * Place a field for an anchor item. When the run carries a blank line
 * (underscores), the field overlays it; otherwise it sits just to the right of
 * the label, where a signer would write.
 */
const place = (
  type: FieldType,
  item: TextItem,
  page: number,
): DetectedField => {
  const x = item.transform[4] ?? 0;
  const y = item.transform[5] ?? 0;
  const height = Math.max(item.height || 12, 12);
  const charW = item.str.length > 0 ? item.width / item.str.length : 6;

  const underscoreAt = item.str.search(UNDERSCORES);
  if (underscoreAt >= 0) {
    const run = item.str.slice(underscoreAt).match(UNDERSCORES)?.[0] ?? "";
    return {
      type,
      page,
      x: x + underscoreAt * charW,
      y,
      width: Math.max(run.length * charW, 80),
      height,
    };
  }
  return { type, page, x: x + item.width + 6, y, width: 180, height };
};

/** Extract text items with positions for every page */
const extractItems = async (
  pdf: Uint8Array,
): Promise<{ page: number; items: TextItem[] }[]> => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdfjs transfers (detaches) the data buffer to its worker, so pass a copy to
  // leave the caller's PDF bytes intact for storage and signing.
  // isEvalSupported:false hardens parsing of untrusted uploads; cast because the
  // legacy build's types omit the option that the runtime accepts
  const options = {
    data: pdf.slice(),
    isEvalSupported: false,
    useSystemFonts: false,
  };
  const task = pdfjs.getDocument(
    options as Parameters<typeof pdfjs.getDocument>[0],
  );
  const pages: { page: number; items: TextItem[] }[] = [];
  try {
    const doc = await task.promise;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      pages.push({ page: p, items: content.items as unknown as TextItem[] });
    }
  } finally {
    // destroy the task even when parsing threw, so a malformed upload never
    // leaves the shared worker in a state that breaks the next document
    await task.destroy().catch(() => {});
  }
  return pages;
};

/** Extract all page text as a single string, best-effort (empty on failure) */
export const extractText = async (pdf: Uint8Array): Promise<string> => {
  try {
    const pages = await extractItems(pdf);
    return pages
      .flatMap((p) => p.items.map((i) => i.str))
      .join(" ")
      .trim();
  } catch {
    return "";
  }
};

/** Detect fillable fields on a PDF, best-effort */
export const detectFields = async (
  pdf: Uint8Array,
): Promise<DetectedField[]> => {
  try {
    const pages = await extractItems(pdf);
    const fields: DetectedField[] = [];
    for (const { page, items } of pages) {
      for (const item of items) {
        // A real field is a blank to fill (an underscore line), not a prose
        // mention of "sign"/"date"/"initials". Requiring a blank is what keeps a
        // legal document from sprouting a field next to every such word. Classify
        // the blank by an anchor in its own run, else by the nearest anchor
        // label to its left on the same line ("Signature:" then "______")
        const blank = item.str.match(UNDERSCORES)?.[0];
        if (!blank) continue;
        // A long underscore run is a signing line: sign on the line itself. A
        // trailing label ("____ Date") names a separate field, not the blank, so
        // it must not re-type the signing line. Short blanks are typed by their
        // own anchor, else by the nearest label to the left
        const type =
          blank.length >= 18
            ? "signature"
            : (classify(item.str) ?? labelToLeft(item, items));
        if (!type) continue;
        fields.push(place(type, item, page));
      }
    }
    return fields;
  } catch (err) {
    console.warn(
      "[signet] field detection failed, signing without fields",
      err,
    );
    return [];
  }
};
