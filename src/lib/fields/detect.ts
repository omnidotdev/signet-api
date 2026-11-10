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

/** Index of the last match of a pattern in a string, or -1 */
const lastMatchIndex = (re: RegExp, str: string): number => {
  const g = new RegExp(
    re.source,
    re.flags.includes("g") ? re.flags : `${re.flags}g`,
  );
  let idx = -1;
  let m: RegExpExecArray | null = g.exec(str);
  while (m !== null) {
    idx = m.index;
    if (m.index === g.lastIndex) g.lastIndex++;
    m = g.exec(str);
  }
  return idx;
};

/**
 * Classify a blank by the anchor label immediately before it within the same
 * text run, so a line like "______ Date: ______" yields a signature then a
 * date. Returns the type of the nearest (last) label before the blank, or null.
 */
const classifyBefore = (before: string): FieldType | null => {
  const i = lastMatchIndex(INITIALS, before);
  const s = lastMatchIndex(SIGNATURE, before);
  const d = lastMatchIndex(DATE, before);
  const max = Math.max(i, s, d);
  if (max < 0) return null;
  if (max === i) return "initials";
  if (max === s) return "signature";
  return "date";
};

const ALL_UNDERSCORES = /_{3,}/g;

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
        // A real field is a blank to fill (an underscore run), not a prose
        // mention of "sign"/"date"/"initials". Requiring a blank is what keeps a
        // legal document from sprouting a field next to every such word. A single
        // run can carry several blanks ("______ Date: ______"), so place a field
        // for EACH blank, classified by the label just before it
        const str = item.str;
        const x = item.transform[4] ?? 0;
        const y = item.transform[5] ?? 0;
        const height = Math.max(item.height || 12, 12);
        const charW = str.length > 0 ? item.width / str.length : 6;

        for (const run of str.matchAll(ALL_UNDERSCORES)) {
          const idx = run.index ?? 0;
          const blank = run[0];
          const before = str.slice(0, idx);
          // label within this run (nearest), else: a long run is a signing line
          // (signature), else classify by a label in an earlier run/item to the
          // left on the same line ("Signature:" then "______")
          const type =
            classifyBefore(before) ??
            (blank.length >= 18 ? "signature" : labelToLeft(item, items));
          if (!type) continue;
          fields.push({
            type,
            page,
            x: x + idx * charW,
            y,
            width: Math.max(blank.length * charW, 80),
            height,
          });
        }
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
