/**
 * Format the ISO date a date field carries (yyyy-mm-dd) into the display string
 * the sender configured for that field. Senders expect locale date styles rather
 * than a bare ISO string, so a date field stores a `dateFormat` and the value is
 * rendered through it when the signer signs. An input that is not a plain ISO
 * date (a signer's free-typed value) is returned unchanged, and an unknown
 * format falls back to ISO.
 */

/** The date styles a sender can pick for a date field */
export const DATE_FORMATS = ["iso", "us", "eu", "long"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export const isDateFormat = (value: unknown): value is DateFormat =>
  typeof value === "string" &&
  (DATE_FORMATS as readonly string[]).includes(value);

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const formatDate = (value: string, format?: string | null): string => {
  const match = ISO_DATE.exec(value);
  // a non-ISO value (free-typed by a signer) is left exactly as entered
  if (!match) return value;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  // reject impossible dates rather than render a misleading string
  if (month < 1 || month > 12 || day < 1 || day > 31) return value;
  const mm = m as string;
  const dd = d as string;
  switch (format) {
    case "us":
      return `${mm}/${dd}/${year}`;
    case "eu":
      return `${dd}/${mm}/${year}`;
    case "long":
      return `${MONTHS[month - 1]} ${day}, ${year}`;
    default:
      return value;
  }
};
