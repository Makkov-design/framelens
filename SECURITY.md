# Security policy

Please report vulnerabilities privately through GitHub's "Report a vulnerability" button on the repository's Security
tab, not in a public issue. You should get a reply within a week.

In scope: anything that could leak the Gemini API key or another key or cookie Frame Lens is given, make the server
request something other than what the user pointed it at (or break the network rules below), write to stdout outside
the MCP protocol, write or delete files outside the places named below, or let video, page or file content take
control of the calling assistant beyond what the README's "Privacy and design principles" describe.

## Network rules a report can hold us to

- `exact` links: the host the user names may be anywhere, a local dev server included. A redirect to any other host
  must be https and resolve only to public addresses; the request then goes to the checked address. A redirect may
  not add a user name or password. A response is at most 30 MB after decoding gzip, deflate or br, and 30 s.
- The user's own cobalt instance: the same rule, with the instance as the trusted host.
- Links fetched with yt-dlp (any link that is not YouTube): before yt-dlp runs, Frame Lens sends the link one plain
  GET and walks the redirects its server answers with (at most 5, 15 s in all), under the same rule as `exact`; a
  refused hop means yt-dlp is never started. Exempt: the link's own origin (same scheme, host and port), which may be
  local, and a user name and password in the link the user gave, which a redirect on that same origin may keep (a
  relative Location inherits them). Refused: a redirect to another origin that is not https (an http-to-http redirect
  to another host included), or that resolves to this computer, the local network or a cloud metadata address, and
  any redirect that adds or changes a user name or password, or carries one to another origin. Not covered: a server that answers yt-dlp differently from that GET, the requests a site
  extractor makes on its own (API and media addresses it builds), and a link this computer cannot reach directly (for
  example only through a proxy), where the walk is skipped and yt-dlp's own result stands.
- `web`: the requests of its browser go through a proxy inside Frame Lens. Tested: the page and its redirects, plain,
  sandboxed `srcdoc` and cross-site frames, scripts, images, fetch, dedicated, nested, blob, shared and service workers
  (also at install time), speculation-rules prefetches and WebSockets. WebRTC is turned off: its constructors are
  removed before any page script runs, in the tab, in new about:blank, sandboxed and cross-site frames (tested) and in
  popups (same mechanism, not tested), because Chrome opens WebRTC's TCP connections to this computer's own address
  directly, around the proxy. A host is resolved once; one
  with any address on this computer, the local network, a cloud metadata address or another non-public range
  (IPv4-mapped and other IPv6 forms included) is refused, and the connection goes to the address that was checked.
  Exempt: only the user's own input when it is literally `localhost` or a loopback or private IP, and only that host:
  a page on the user's own local host can then reach other ports of that same host. A public name that resolves to a
  private address is never exempt. The proxy listens on 127.0.0.1 and serves only the browser Frame Lens started
  (per-run credentials, never forwarded to a site); if it cannot start, the page is not opened. The result names an
  address the page was read at other than the one given, and the hosts that were refused. The browser's own DevTools
  port on 127.0.0.1 is refused for page requests, also from an exempt local page. Not covered: QUIC is turned off
  rather than checked; a kind of request no test above covers is not claimed; browser policies set by an
  administrator could override the proxy setting.
  Behind the network's own proxy (HTTPS_PROXY, HTTP_PROXY or ALL_PROXY, with NO_PROXY honoured; http and https
  proxies only, anything else makes `web` refuse), checked requests go on through that proxy, with its own
  credentials from its URL. Local, private and metadata addresses and local names are still refused before anything
  is sent, and a name this computer resolves to such an address too. Every request goes to that proxy by name, and it
  resolves the name again itself: behind an upstream proxy the address pin is not available (DNS rebinding is then
  up to that proxy), also for names checked here, and a name this computer cannot resolve at all goes there too. The
  result says how many hosts went that way.
- The login-profile capture downloads the page's media over https only, and every hop must resolve to a public address,
  connected to as checked.
- Downloads through yt-dlp stop at `FRAMELENS_MAX_DOWNLOAD_MB`, also when the site gives no size up front.
- ffmpeg, ffprobe, yt-dlp and the browser get no `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `FIGMA_TOKEN`,
  `FRAMELENS_COBALT_KEY` or `FRAMELENS_COOKIES_*` in their environment.
- A workspace record (`.framelens/<id>/source.json`) is reused only for the same link, and only for files whose real
  path is inside that workspace's own `media` folder. No workspace write follows a link out of the workspace folder, and no workspace file with a second name (a hard link)
  is read or written. That includes a workspace the user copied with hard links (`cp -al`, some backup tools): the tool
  fails and says to copy it without hard links or delete it.
- `framelens logout` deletes only a folder that `framelens login` made, recorded in this user's own
  `~/.framelens/browser-profiles.json` by its real path, and that still has its marker file; or the default
  `~/.framelens/browser-profile` when neither it nor `~/.framelens` is a link. A marker alone (one that came with a
  repository) is not enough, and a custom profile from 2.1 is refused: delete it by hand.
- Exports name the source link without its query, fragment, user name or path parameters (`;jsessionid=…`, also
  written `%3B`), and with `…` for a path segment after one named `token`, `access_token`, `auth`, `key`, `api_key`,
  `sig`, `signature`, `secret`, `session`, `sid`, `jwt`, `hmac`, `password` or `credential(s)`, and for the value of
  a `name=value` segment with such a name (`/auth=…/`). Other ids in the path (a Figma file key, a Drive file id, a
  Loom id) are the address itself and are kept. A user name and password in a link the user
  gave are left out of tool results, error messages, progress lines, the log, motion-spec.json and every file but the
  workspace's source.json.
- Error results that quote ffmpeg's or yt-dlp's output keep it to one line of at most 200 characters and carry the
  third-party notice.
- No answer from a download source may crash the server (`test/runtime/download-guard.test.ts`).
