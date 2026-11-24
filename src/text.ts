/**
 * Third-party text (a source's title, a caption, a page's element ids, a Lottie layer name) on one line, for
 * comments, Markdown and summaries. TikTok and Instagram titles are the post's caption and can hold line breaks: in a
 * `//` comment the next line would run as code in the user's project, and in Markdown it would start a heading.
 * C1 controls, soft hyphens, zero-width and other invisible format characters, bidi marks, overrides and isolates,
 * interlinear annotations, tag characters and the byte-order mark go too: they hide or reorder what a reader sees.
 */
export function oneLine(text: unknown, max = 200): string {
  return String(text ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb`]+|[\u{e0000}-\u{e007f}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Third-party text for Markdown prose and table cells: one line (as `oneLine`), with the characters that make links,
 * images, HTML, emphasis, strikethrough or table columns escaped, and bare URLs defused so they stay plain text. Use it
 * after a list marker or a table pipe (one line cannot start a heading there).
 */
export function mdText(text: unknown, max = 200): string {
  return oneLine(text, max)
    .replace(/[\\*_[\]<>|~]/g, "\\$&")
    .replace(/:\/\//g, ":\\/\\/")
    .replace(/\bwww\./gi, "www\\.");
}

/** A colour from untrusted data as `#RRGGBB`, or the fallback: it lands in generated HTML, CSS and scripts. */
export function safeHex(value: unknown, fallback = "#111111"): string {
  if (typeof value !== "string") return fallback;
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v.slice(1).replace(/./g, (c) => c + c)}`.toUpperCase();
  return fallback;
}

/**
 * A source link for files people share (exports): without a user name, password, query or fragment, which can carry
 * access tokens (a signed link's parameters). A YouTube watch link keeps its video id. Anything that is not an
 * http(s) link (a file path) is returned as is.
 */
export function shareableLink(text: string): string {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return text;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return text;
  const v = /(^|\.)youtube\.com$/i.test(url.hostname) ? url.searchParams.get("v") : null;
  return `${url.origin}${url.pathname}${v ? `?v=${encodeURIComponent(v)}` : ""}`;
}

/** Text with any `user:password@` taken out of the links in it: a link the user gave may carry their credentials. */
export function hideCredentials(text: string): string {
  return String(text ?? "").replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi, "$1");
}
