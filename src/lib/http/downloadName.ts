/**
 * A PDF file name from a document's title as the app shows it, so a download
 * is named after the document (never a doubled ".pdf", never characters a file
 * system rejects). An optional suffix tells related files apart
 */
export const pdfFileName = (title: string, suffix?: string): string => {
  const base =
    title
      .replace(/\.(pdf|docx|png|jpe?g)$/i, "")
      .replace(/[\p{Cc}\\/:*?"<>|]/gu, " ")
      .replace(/\s+/g, " ")
      .trim() || "document";
  return `${base}${suffix ? ` ${suffix}` : ""}.pdf`;
};

/**
 * A Content-Disposition header carrying the file name both as a plain ASCII
 * fallback and as UTF-8 (RFC 6266), so names with accents or emoji survive
 */
export const contentDisposition = (
  disposition: "attachment" | "inline",
  filename: string,
): string => {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const utf8 = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
};
