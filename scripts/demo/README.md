# Frame Lens demo (HyperFrames source)

The 28.6-second demo in `docs/assets/demo.*`, built only from real material: frames of the Big Buck Bunny
trailer and Frame Lens's reading of its cuts and colours (`docs/assets/bbb/reading.js`), two moves with known
curves that Frame Lens measures back from this very render (the `CURVES` object in `compositions/proof.html`) and
the code it exported from them, the install command and the site. `SPEC.md` is the shot list with every time; `CHECK.md` is Frame Lens
measuring this render; credits are in `docs/assets/demo/CREDITS.md`.

## Re-render

From this folder (Node 20+, ffmpeg on PATH):

```bash
node fetch-fonts.mjs
npx --yes hyperframes@0.9.9 check
npx --yes hyperframes@0.9.9 render --fps 30 --workers 2 --quality delivery -o renders/demo-master.mp4
```

Then encode the deliverables (run from the repository root):

```bash
M=scripts/demo/renders/demo-master.mp4
AF="loudnorm=I=-18:TP=-3:LRA=11,alimiter=limit=0.7:level=disabled"
ffmpeg -y -i $M -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart -af "$AF" -ar 48000 -c:a aac -b:a 128k docs/assets/demo.mp4
ffmpeg -y -i $M -an -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart docs/assets/demo-silent.mp4
ffmpeg -y -i $M -c:v libvpx-vp9 -b:v 0 -crf 36 -row-mt 1 -deadline good -cpu-used 4 -af "$AF" -ar 48000 -c:a libopus -b:a 96k docs/assets/demo.webm
ffmpeg -y -ss 27.5 -i $M -frames:v 1 docs/assets/demo-poster.png
ffmpeg -y -i $M -vf "fps=12,scale=800:-1:flags=lanczos,palettegen=stats_mode=diff" palette.png
ffmpeg -y -i $M -i palette.png -lavfi "fps=12,scale=800:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" docs/assets/demo.gif
```

The fonts (Fontshare, ITF Free Font License) are downloaded, not committed. The sound effects are cut from
the Openverse recordings next to them (`assets/sfx/`), and `audio_request.json` is the request that found them.
