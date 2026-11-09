# Frame Lens measuring its own demo

The demo was rendered by HyperFrames 0.9.9 at 1920×1080, 30 fps (`renders/demo-master.mp4`, encoded to
`docs/assets/demo.mp4`), then read back by Frame Lens from `main` (commit 909cf07, the bundled MCP server
`dist/framelens.mjs`, which reports itself as 2.0.0 and already has `track`) with `track` on each move and `style`
on the whole film. The measured moves are shown in the film itself (the proof scene's `CURVES` object in
`compositions/proof.html`), so the video was rendered twice: v1 to measure, then the final with the values filled
in. The moves did not change between the two renders, and both renders measure the same (the spring's stiffness
read 170.03 on v1 and 170.01 on the final).

## Moves: animated vs measured

Both are a 96 px red square on the plain green field, travelling 640 px in x, held still for 0.8 s before and
for the rest of the scene after. `track` was given the square's box (128, 288, 96×96 and 128, 688, 96×96) and a
window from 0.3 s before the move.

| | Animated (truth) | Measured by `track` | Difference |
|---|---|---|---|
| **Ease-out**: curve | `cubic-bezier(0.22, 1, 0.36, 1)` | `cubic-bezier(0.2279, 0.9639, 0.3775, 0.9983)` | the two curves put the square within **0.08 px** of each other on every frame |
| Ease-out: start | 10.600 s (frame 318) | 10.600 s, delay 0.000 s | 0 frames |
| Ease-out: length | 18 frames (0.600 s) | 16.73 frames (0.558 s) | the last two frames move 0.14 px and 0.02 px, below what can be measured; the fit ends the move there |
| Ease-out: travel | 176 → 816 px (centre x) | 176 → 816 px | 0 px |
| Ease-out: fit | | error 0.01 % of the travel, quality **exact**, "a cubic-bezier fits best" | |
| **Spring**: model | stiffness 170, damping 12, mass 1 (ζ 0.460, ω 13.04 rad/s), closed-form damped spring from rest as a GSAP ease over 1.2 s | `spring(stiffness 170.01, damping 12, mass 1)`, ζ 0.4602, ω 13.0389 | within **0.023 px** on every frame; "the value swings back across its target 1 time" |
| Spring: start | 12.800 s (frame 384) | 12.800 s, delay 0.000 s | 0 frames |
| Spring: length | tween 36 frames; overshoots 125 px at frame 8 | settles in 26.75 frames (0.892 s), perceptual 0.482 s, bounce 0.54 | a spring's length is a settle threshold, not a parameter |
| Spring: fit | | error 0.01 % of the travel, quality **exact** | |

The export of the same reading (`export css`, `export remotion`) carries both curves exactly: the CSS line
`animation: fl-enter 0.558s cubic-bezier(0.2279, 0.9639, 0.3775, 0.9983) 10.6s both;` and the Remotion entry
`spring: { stiffness: 170.03, damping: 11.999, mass: 1 }` (from v1) are what the code scene shows.

`style` alone (no `track`) lists the same two moves with their start right (10.600 s, 12.800 s) and their family
(ease-out), with shorter, coarser lengths (11 and 15 frames) because it reads them from the frame-change energy;
`track` is the measurement to use.

## Cuts: animated vs measured

Truth here is read from the pixels of the render (frame-to-frame difference of the loupe area and of the whole
frame), not from the composition's numbers: the loupe swaps two images at 6.067 s and 7.867 s, which land on the
following frame (183, 237) because the frame times are 6.0667 s and 7.8667 s.

| Frame | Time | What changes | `style` |
|---|---|---|---|
| 84 | 2.800 s | title → loupe (whole frame) | found, 0 frames off |
| 145 | 4.833 s | loupe: trailer shot 1 → 2 | found, 0 |
| 156 | 5.200 s | shot 2 → 3 | found, 0 |
| 168 | 5.600 s | shot 3 → 4 | **missed** (see bug 2) |
| 171 | 5.700 s | shot 4 → 5 | **missed** (see bug 2) |
| 177 | 5.900 s | shot 5 → 6 | found, 0 |
| 183 | 6.100 s | shot 6 → 7 | found, 0 |
| 186 | 6.200 s | shot 7 → 8 | found, 0 |
| 231 | 7.700 s | shot 8 → 9 | found, 0 |
| 237 | 7.900 s | shot 9 → 10 | found, 0 |
| 258 | 8.600 s | shot 10 → 11 | found, 0 |
| 264 | 8.800 s | shot 11 → 12 (white title card → white credit card, inside the loupe only) | **missed**: the change is 7.3 on the loupe area and 3.0 on the whole frame, below the cut floor |
| 294 | 9.800 s | loupe → proof | found, 0 |
| 510 | 17.000 s | proof → palette | found, 0 |
| 600 | 20.000 s | palette → code | found, 0 |
| 738 | 24.600 s | code → end card | found, 0 |

13 of 16 cuts found, every one on the exact frame. Six cuts reported that are not cuts: frames 354, 483, 618,
633, 681 and 711 (11.800, 16.100, 20.600, 21.100, 22.700, 23.700 s). See bug 1.

## Bugs found

1. **`parseEnergy` drops the exponent of ffmpeg's numbers** (`src/style/motion.ts:54`,
   `/lavfi\.signalstats\.([YUV])AVG=([\d.]+)/`). signalstats prints tiny averages in scientific notation
   (`YAVG=6.94444e-05`); the regex reads `6.94444`. On a still frame where a handful of pixels change, the energy
   becomes 6.9 to 10.4 instead of about 0.0001, which passes `energySpikeCuts` (floor 6, six times the median of a
   mostly still film), so six false cuts appear, all with energy exactly 6.945 or 10.417. The two frames around
   11.800 s differ by at most 28/255 on a few pixels. Fix: accept an exponent, e.g. `([\d.]+(?:e[-+]?\d+)?)`, and
   `Number()` parses it. The same regex shape is in `src/style/motion.ts:48` (pts_time), `src/media/frames.ts:64`,
   `src/media/boundaries.ts:29,31`, `src/compare/compare.ts:33` and `src/audio/analyze.ts:46-53`; those values are
   printed with fixed decimals today, but the same fix makes them safe. This also inflates the energy of real moves
   on flat graphics, so `style` move lengths on such films are affected too.
2. **A shot of 3 frames between two different pictures is read as a flash** (`flashPartner` in
   `src/style/motion.ts`, used by `classifyChanges`). Frames 168 and 171 are two real cuts (energy 38.9 and 22.6,
   each standing alone); because they are 3 frames apart and of similar size, the first is classed `flash` and
   neither becomes a cut. A flash returns to the picture it left; a short shot does not. Comparing the frame after
   the second spike with the frame before the first would tell them apart. Montage edits with 2-3 frame shots
   hit this.
3. Not a bug, a limit worth knowing: a cut inside a region that covers about a third of the frame, between two
   similar pictures (white card → white card), scores 3.0 on the whole frame and is not found.

## Not shown, on purpose

The Big Buck Bunny reading's "move" at 26.04-26.96 s (`cubic-bezier(0.7, 0, 0.84, 0)`, 23 frames) is not one move:
26.00 s is a cut, the shot fades to white at 26.68-26.76 s and the logo scales in from 26.80 s. The demo does not
present it as a measured move. The proof scene's `CURVES` object is the one place to add a corrected trailer move
when it lands. The cut ticks on the loupe use the reading's cut times, which are correct.
