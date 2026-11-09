/**
 * One reading of a site's or yt-dlp's error text for access control (design principle 7). Two places ask it:
 * whether a failed link may go to the user's own cobalt instance (only when nothing here matches), and whether the
 * Frame Lens login profile may play it (never for a bot check, a challenge, a rate limit or a block). Links inside the
 * text are left out first: their words say nothing about why the request failed.
 */

/**
 * Proving a human is there, or the site slowing or shutting this connection out: never answered with the user's
 * login, never routed around.
 */
const BOT_OR_LIMIT =
  /\bbots?\b|anti.?bot|captcha|challenge|cloudflare|unusual traffic|\b429\b|too many requests|rate.?limit|\bblock(ed|ing)?\b|po.?token|\bgvs\b|impersonat|verify (you|that you|your (age|identity|account))|\bhuman/i;

/**
 * Everything else that may be access control: logins and accounts, age gates, private, members-only, paid or
 * password-protected posts, DRM, regions, HTTP 401/403/407/451, permissions.
 */
const GATED =
  /\b(401|403|407|451)\b|forbidden|unauthori[sz]ed|unavailable for legal reasons|\bconfirm|\bage\b|age.?(gate|restrict|verif)|inappropriate|log.?in|logged.?in|sign.?in|authenticat|credential|account|cookie|nsfw|adult|\bmature|sensitive|\bprivate\b|protected|password|members?.only|exclusive|subscri|premium|paywall|payment|\bpaid\b|purchase|\bbuy\b|\brent(al|ed)?\b|\bdrm\b|not available (in|from) your|\bgeo|country|region|\blocation|registered users|permission|denied|restricted/i;

const withoutLinks = (text: string) => text.replace(/https?:\/\/\S+/gi, " ");

/** A bot check, challenge, rate limit or block. */
export function isBotCheckOrLimit(text: string): boolean {
  return BOT_OR_LIMIT.test(withoutLinks(text));
}

/** Anything that may be access control. Deliberately wide: a failure that matches is never sent to cobalt. */
export function mayBeAccessControl(text: string): boolean {
  const t = withoutLinks(text);
  return BOT_OR_LIMIT.test(t) || GATED.test(t);
}
