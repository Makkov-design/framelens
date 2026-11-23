# Security policy

Please report vulnerabilities privately through GitHub's "Report a vulnerability" button on the repository's Security
tab, not in a public issue. You should get a reply within a week.

In scope: anything that could leak the Gemini API key, make the server request something other than a YouTube video,
write to stdout outside the MCP protocol, or let video content take control of the calling assistant beyond what is
described in the README's Security section.

## Network rules a report can hold us to

- `exact` links: the host the user names may be anywhere, a local dev server included. A redirect to any other host
  must be https and resolve only to public addresses; the request then goes to the checked address. A redirect may
  not add a user name or password. A response is at most 30 MB after decoding gzip, deflate or br, and 30 s.
- The user's own cobalt instance: the same rule, with the instance as the trusted host.
- Downloads through yt-dlp stop at `FRAMELENS_MAX_DOWNLOAD_MB`, also when the site gives no size up front.
- No answer from a download source may crash the server (`test/runtime/download-guard.test.ts`).
