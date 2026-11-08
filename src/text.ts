/**
 * Third-party text (a source's title, a caption, a page's element ids, a Lottie layer name) on one line, for
 * comments, Markdown and summaries. TikTok and Instagram titles are the post's caption and can hold line breaks: in a
 * `//` comment the next line would run as code in the user's project, and in Markdown it would start a heading.
 */
export function oneLine(text: unknown, max = 200): string {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029`]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** A colour from untrusted data as `#RRGGBB`, or the fallback: it lands in generated HTML, CSS and scripts. */
export function safeHex(value: unknown, fallback = "#111111"): string {
  if (typeof value !== "string") return fallback;
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v.slice(1).replace(/./g, (c) => c + c)}`.toUpperCase();
  return fallback;
}
