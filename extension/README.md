# Frame Lens browser extension

Two buttons for the page you are on, in your own browser (Chrome or Edge), where you are already logged in:

- **Read this page's motion**: Frame Lens's own page reader (the same code the `web` tool runs) reads every
  running animation (CSS animations and transitions, Web Animations, Motion, GSAP's timeline when the page has it),
  the fonts and the colours, at the top and while scrolling once to the bottom. The result is saved as
  `Downloads/FrameLens/page-<site>-<time>.framelens.json`.
- **Record this tab**: records what the tab shows, with its sound, until you press **Stop and save the recording**
  (or after 15 minutes). The video is saved as `Downloads/FrameLens/recording-<site>-<time>.webm`. This is the honest
  way to study a reel or a post behind your login: you record what you watch.

Nothing is sent anywhere: the extension makes no network requests of its own and loads no code from the internet.
It asks for `activeTab` (only the tab you open it on, only when you open it), `scripting` (to run the reader there),
`downloads` (to save the files), and `tabCapture` and `offscreen` (to record).

Then, in your agent, Frame Lens finds the files in `Downloads/FrameLens` by itself:

- the page reading: `web` with `inbox` (or the file's path) writes `motion-spec.json` and `STYLE.md` exactly as for a
  live page, so `export` works;
- the recording: any video tool (`probe`, `plan`, `frames`, `style`, …) with source `inbox`.

If your browser saves downloads somewhere else, set `FRAMELENS_DOWNLOADS` to that folder (or `FRAMELENS_INBOX` to
its `FrameLens` subfolder).

## Install (Load unpacked)

The built extension is in `extension/dist` of the Frame Lens repository (or unpack
`framelens-extension-<version>.zip` from `npm run build:extension` into a folder).

**Chrome**

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension/dist` folder.
4. Pin Frame Lens from the puzzle-piece menu so its button is always there.

**Edge**

1. Open `edge://extensions`.
2. Turn on **Developer mode** (left side).
3. Click **Load unpacked** and choose the `extension/dist` folder.
4. Show it in the toolbar from the Extensions menu.

Browsers do not let extensions read their own pages (`chrome://`, `edge://`) or the extension stores.

## Build

```bash
npm run build:extension   # writes extension/dist and extension/framelens-extension-<version>.zip
```

The reader in `dist/reader.js` is generated from `src/browser/page-script.ts`, and the service worker bundles the
same cleaning and merging code the `web` tool uses, so the two always read a page the same way. The code is not
minified, so you can read exactly what runs.
