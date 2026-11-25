/**
 * Third-party text (a source's title, a caption, a page's element ids, a Lottie layer name) on one line, for
 * comments, Markdown and summaries. TikTok and Instagram titles are the post's caption and can hold line breaks: in a
 * `//` comment the next line would run as code in the user's project, and in Markdown it would start a heading.
 * C1 controls, soft hyphens, zero-width and other invisible format characters, bidi marks, overrides and isolates,
 * interlinear annotations, tag characters, variation selectors, blank fillers (Hangul fillers, the braille blank,
 * the combining grapheme joiner, musical and shorthand format marks) and the byte-order mark go too: they hide or reorder what a
 * reader sees. Two keep their place where they belong to the spelling: the zero-width non-joiner and joiner between
 * letters, and the joiner between emoji; variation selectors are dropped without a space.
 */
export function oneLine(text: unknown, max = 200): string {
  return String(text ?? "")
    // Variation selectors (with the supplement's) only pick a glyph's form, such as an emoji's colour: dropping them
    // leaves the word whole.
    .replace(/[\ufe00-\ufe0f\u{e0100}-\u{e01ef}]+/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\u034f\u115f\u1160\u3164\u2800\ufeff\ufff9-\ufffb`]+|[\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}]+/gu, " ")
    // The zero-width non-joiner and joiner are part of the spelling between letters (Persian and several Indic scripts
    // need them inside words) and between emoji (a joined emoji): kept there, a space anywhere else. Decided after the
    // rest is stripped, so a joiner whose neighbour was an invisible mark ends up next to a space and goes too.
    .replace(/[\u200c\u200d]/g, (joiner, at: number, all: string) => (keepJoiner(joiner, all.slice(Math.max(0, at - 2), at), all.slice(at + 1, at + 3)) ? joiner : " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** A joiner between two letters (either joiner), or the joiner between two emoji; each side is one character (two code units). */
function keepJoiner(joiner: string, before: string, after: string): boolean {
  if (/[\p{L}\p{M}]$/u.test(before) && /^\p{L}/u.test(after)) return true;
  return joiner === "\u200d" && /\p{Extended_Pictographic}$/u.test(before) && /^\p{Extended_Pictographic}/u.test(after);
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
 * access tokens (a signed link's parameters), and without the parts of its path that can (see `shareablePath`). A
 * YouTube watch link keeps its video id. Anything that is not an http(s) link (a file path) is returned as is.
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
  return `${url.origin}${shareablePath(url.pathname)}${v ? `?v=${encodeURIComponent(v)}` : ""}`;
}

/**
 * Names that mark a credential in a path: the segment after one (`/token/<secret>/v.mp4`), or the value of a
 * `name=value` segment (`/auth=<secret>/v.mp4`).
 */
const SECRET_NAME = /^(token|access[-_]?token|auth|key|api[-_]?key|sig|signature|secret|session|sid|jwt|hmac|password|credentials?)$/i;

/**
 * A link's path without what holds access by name: path parameters (`;jsessionid=…`, also written `%3B`), the
 * segment after one named like a token or key, and the value of a `name=value` segment with such a name. Those are
 * shown as `…`, so the link still reads as the same place. Ids that are the address itself (a Figma file key, a Drive
 * file id, a Loom id, a slug) are kept: hiding them would break the link.
 */
function shareablePath(path: string): string {
  const parts = path.split("/").map((part) => part.replace(/(;|%3b).*$/is, ""));
  return parts
    .map((part, i) => {
      if (i > 0 && part && SECRET_NAME.test(decodeSegment(parts[i - 1]!))) return "…";
      const pair = /^([^=]+)=(.+)$/s.exec(decodeSegment(part));
      if (pair && SECRET_NAME.test(pair[1]!)) return `${encodeURIComponent(pair[1]!)}=…`;
      return part;
    })
    .join("/");
}

function decodeSegment(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** Text with any `user:password@` taken out of the links in it: a link the user gave may carry their credentials. */
export function hideCredentials(text: string): string {
  return String(text ?? "").replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi, "$1");
}
