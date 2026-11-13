/**
 * Convert an office document (DOCX) to PDF with a headless LibreOffice process.
 * LibreOffice is an optional part of the runtime image: when the `soffice` binary
 * is not present the converter reports itself unavailable and the caller rejects
 * the upload cleanly rather than hanging. The binary is added to the API image so
 * DOCX uploads render with full fidelity in production.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Override the binary name/path when LibreOffice is installed elsewhere */
const SOFFICE = process.env.SOFFICE_PATH || "soffice";
/** A conversion that runs longer than this is treated as stuck and killed */
const CONVERT_TIMEOUT_MS = 30_000;

let cachedAvailable: boolean | null = null;

/** Whether a headless office converter is installed in this runtime image */
export const isOfficeConverterAvailable = (): boolean => {
  if (cachedAvailable === null) cachedAvailable = Bun.which(SOFFICE) !== null;
  return cachedAvailable;
};

const runSoffice = (args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(SOFFICE, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("office conversion timed out"));
    }, CONVERT_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`office conversion exited with code ${code}`));
    });
  });

/**
 * Convert the given office-document bytes to PDF. Writes the input to a private
 * temp directory, runs LibreOffice headless against an isolated user profile (so
 * concurrent conversions do not collide on a shared profile lock), reads the
 * produced PDF, and cleans up. Throws when conversion fails or produces nothing.
 */
export const convertOfficeToPdf = async (
  bytes: Uint8Array,
  ext: string,
): Promise<Uint8Array> => {
  const dir = await mkdtemp(join(tmpdir(), "signet-office-"));
  try {
    const input = join(dir, `in.${ext}`);
    await writeFile(input, bytes);
    await runSoffice([
      "--headless",
      "--nolockcheck",
      "--nodefault",
      "--norestore",
      `-env:UserInstallation=file://${join(dir, "profile")}`,
      "--convert-to",
      "pdf",
      "--outdir",
      dir,
      input,
    ]);
    const pdf = await readFile(join(dir, "in.pdf"));
    if (pdf.length === 0)
      throw new Error("office conversion produced no output");
    return new Uint8Array(pdf);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
