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
- Links fetched with yt-dlp (any link that is not YouTube): before yt-dlp runs, Frame Lens sends the link one plain
  GET and walks the redirects its server answers with (at most 5), under the same rule as `exact`; a refused hop means
  yt-dlp is never started. Not covered: a server that answers yt-dlp differently from that GET, the requests a site
  extractor makes on its own (API and media addresses it builds), and a link this computer cannot reach directly (for
  example only through a proxy), where the walk is skipped and yt-dlp's own result stands.
- `web`: every document the page loads (its redirects, the navigations its scripts start, its frames) is held until
  its host is checked; one that resolves to this computer, the local network or a cloud metadata address is refused,
  unless it is the host the user gave. The result names an address it was read at other than the one given. Images,
  scripts and other subresources are not checked, and the browser resolves names itself (no pinned address).
- The login-profile capture downloads the page's media over https only, and every hop must resolve to a public address,
  connected to as checked.
- Downloads through yt-dlp stop at `FRAMELENS_MAX_DOWNLOAD_MB`, also when the site gives no size up front.
- ffmpeg, ffprobe, yt-dlp and the browser get no `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `FIGMA_TOKEN`,
  `FRAMELENS_COBALT_KEY` or `FRAMELENS_COOKIES_*` in their environment.
- A workspace record (`.framelens/<id>/source.json`) is reused only for the same link, and only for files whose real
  path is inside that workspace's own `media` folder. No workspace write follows a link out of the workspace folder.
- `framelens logout` deletes only a folder with the marker `framelens login` writes, or the default profile folder.
- Exports name the source link without its query, fragment or user name.
- Error results that quote ffmpeg's or yt-dlp's output keep it to one line of at most 200 characters and carry the
  third-party notice.
- No answer from a download source may crash the server (`test/runtime/download-guard.test.ts`).
