/** Where the extension saves its files, inside the browser's Downloads folder. Frame Lens's inbox looks there. */
export const FOLDER = "FrameLens";

/** The marker a saved page reading carries, so Frame Lens can tell it from any other JSON. */
export const READING_FORMAT = "framelens.page-reading/1";

const pad = (n: number) => String(n).padStart(2, "0");

/** 20261109-041530 in local time: sorts by time and is safe in every file system. */
export function stamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** The page's host for a file name: letters, digits, dots and dashes only. */
export function hostSlug(url: string | undefined): string {
  let host = "";
  try {
    host = new URL(String(url)).hostname.replace(/^www\./, "");
  } catch {
    // about:blank, a file page
  }
  return host.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60) || "page";
}

export function readingFileName(url: string | undefined, d: Date): string {
  return `${FOLDER}/page-${hostSlug(url)}-${stamp(d)}.framelens.json`;
}

export function recordingFileName(url: string | undefined, d: Date): string {
  return `${FOLDER}/recording-${hostSlug(url)}-${stamp(d)}.webm`;
}
