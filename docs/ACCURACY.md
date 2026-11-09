# Accuracy

Measured by `node scripts/benchmark.mjs` on synthetic videos with known ground truth: a box moves 400 px with a
known easing (cubic in, out, in-out, linear) over 8, 16 or 30 frames at 24, 30 and 60 fps, and each clip ends in a hard
cut to a new background. 36 moves and 33 cuts. This is video measured from pixels; Lottie,
web pages and Figma are read exactly from their data and need no benchmark.

| Measure | Result |
|---|---|
| Cuts found on the exact frame | 33 of 33 |
| Cuts within one frame | 33 of 33 |
| Moves found | 36 of 36 |
| Move start, mean error | 1.00 frames |
| Move duration, mean error | 1.83 frames |
| Easing family correct | 36 of 36 |

Almost all of the start and duration error comes from long moves with a slow end: the first frames of a 30-frame
ease-in (or the last of an ease-out) move the box by less than a pixel at analysis resolution, so the measured move
begins a few frames late or ends early. Short moves and cuts are exact. The easing family is read from where the
movement's weight sits; the exact curve of an important move is measured with `track` (below).

<details><summary>Every move</summary>

| fps | frames | easing | found | start error (frames) | measured frames | family |
|---|---|---|---|---|---|---|
| 24 | 8 | ease-in | yes | 1 | 8 | ease-in |
| 24 | 8 | ease-out | yes | 0 | 8 | ease-out |
| 24 | 8 | ease-in-out | yes | 0 | 8 | ease-in-out |
| 24 | 8 | linear | yes | 0 | 9 | linear |
| 24 | 16 | ease-in | yes | 2 | 15 | ease-in |
| 24 | 16 | ease-out | yes | 0 | 14 | ease-out |
| 24 | 16 | ease-in-out | yes | 1 | 15 | ease-in-out |
| 24 | 16 | linear | yes | 0 | 17 | linear |
| 24 | 30 | ease-in | yes | 5 | 25 | ease-in |
| 24 | 30 | ease-out | yes | 0 | 25 | ease-out |
| 24 | 30 | ease-in-out | yes | 3 | 24 | ease-in-out |
| 24 | 30 | linear | yes | 0 | 30 | linear |
| 30 | 8 | ease-in | yes | 1 | 8 | ease-in |
| 30 | 8 | ease-out | yes | 0 | 8 | ease-out |
| 30 | 8 | ease-in-out | yes | 0 | 8 | ease-in-out |
| 30 | 8 | linear | yes | 0 | 9 | linear |
| 30 | 16 | ease-in | yes | 2 | 15 | ease-in |
| 30 | 16 | ease-out | yes | 0 | 14 | ease-out |
| 30 | 16 | ease-in-out | yes | 1 | 15 | ease-in-out |
| 30 | 16 | linear | yes | 0 | 17 | linear |
| 30 | 30 | ease-in | yes | 5 | 25 | ease-in |
| 30 | 30 | ease-out | yes | 0 | 25 | ease-out |
| 30 | 30 | ease-in-out | yes | 3 | 24 | ease-in-out |
| 30 | 30 | linear | yes | 0 | 30 | linear |
| 60 | 8 | ease-in | yes | 1 | 8 | ease-in |
| 60 | 8 | ease-out | yes | 0 | 8 | ease-out |
| 60 | 8 | ease-in-out | yes | 0 | 8 | ease-in-out |
| 60 | 8 | linear | yes | 0 | 9 | linear |
| 60 | 16 | ease-in | yes | 2 | 15 | ease-in |
| 60 | 16 | ease-out | yes | 0 | 14 | ease-out |
| 60 | 16 | ease-in-out | yes | 1 | 15 | ease-in-out |
| 60 | 16 | linear | yes | 0 | 17 | linear |
| 60 | 30 | ease-in | yes | 5 | 25 | ease-in |
| 60 | 30 | ease-out | yes | 0 | 25 | ease-out |
| 60 | 30 | ease-in-out | yes | 3 | 24 | ease-in-out |
| 60 | 30 | linear | yes | 0 | 30 | linear |

</details>

## Transitions (`style`)

Two test pictures meet in a transition of 12 or 24 frames at 24, 30 and 60 fps: a dissolve (ffmpeg `xfade`
fade), a dip through black and one through white (the first picture fades out over half the frames, three frames of
the colour, the second fades in), and wipes to the left and downwards. "Still" pictures are SMPTE bars and an RGB test
pattern; "moving" ones are ffmpeg's animated `testsrc2` and a zooming Mandelbrot set, so the shots move during the
transition. 60 clips; 60 found with the right kind (and colour or direction). Errors are in
frames against the truth: the start is the last frame of the first picture, the end the first frame of the second, and
the shot boundary belongs on a dissolve's or wipe's halfway frame or on any frame of a dip's hold. "Extra" counts other
transitions and cuts reported in the same clips. In the 3 move-and-cut videos above, 0 gradual transitions were reported where there are none.

| Pictures | Transition | Found right | Start error, mean / max | End error, mean / max | Boundary error, mean / max | Extra |
|---|---|---|---|---|---|---|
| still | dissolve | 6 of 6 | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 0 |
| still | dip through black | 6 of 6 | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 0 |
| still | dip through white | 6 of 6 | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 1 |
| still | wipe left | 6 of 6 | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 0 |
| still | wipe down | 6 of 6 | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 0 |
| moving | dissolve | 6 of 6 | 0.50 / 3.00 | 0.00 / 0.00 | 0.33 / 2.00 | 0 |
| moving | dip through black | 6 of 6 | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 0 |
| moving | dip through white | 6 of 6 | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 0 |
| moving | wipe left | 6 of 6 | 0.67 / 1.00 | 0.00 / 0.00 | 0.00 / 0.00 | 0 |
| moving | wipe down | 6 of 6 | 0.67 / 1.00 | 0.00 / 0.00 | 0.00 / 0.00 | 0 |

Dissolves, fades and dips are recognised by their frames being blends of the two pictures (or of a picture and flat
black or white), so motion inside the shots makes them harder: the blend is checked against the pictures on both
sides, and the frames at its ends that barely move towards the other picture are left out. A wipe is recognised when
each frame is part one picture, part the other, split by a straight edge; on moving pictures its start can be a frame
early here, and more on busier footage. A push (the new picture sliding the old one out) is not recognised as a transition: it is reported as
a move. Wipes and pushes in real footage are rarer than cuts, dissolves and fades, and less tested here.

On real footage, `test/style/real-clip.test.ts` checks the Big Buck Bunny trailer (CC BY 3.0, Blender Foundation;
25 fps, 33 s) against frame-by-frame reading: its two title-card dissolves (3.48–4.44 s and 6.24–7.12 s), five dips to
black (boundaries on the black frames at 18.88, 19.88, 20.88, 21.88 and 22.88 s) and a flash to white (26.72 s) are
found with the boundaries on those frames, and its 11 hard cuts stay where they were.

<details><summary>Every transition clip</summary>

| fps | pictures | transition | frames | found | start error | end error | boundary error | extra |
|---|---|---|---|---|---|---|---|---|
| 24 | still | dissolve | 12 | dissolve | 0 | 0 | 0 | 0 |
| 24 | still | dissolve | 24 | dissolve | 0 | 0 | 0 | 0 |
| 24 | still | dip through black | 12 | dip black | 0 | 0 | 0 | 0 |
| 24 | still | dip through black | 24 | dip black | 0 | 0 | 0 | 0 |
| 24 | still | dip through white | 12 | dip white | 0 | 0 | 0 | 1 |
| 24 | still | dip through white | 24 | dip white | 0 | 0 | 0 | 0 |
| 24 | still | wipe left | 12 | wipe left | 0 | 0 | 0 | 0 |
| 24 | still | wipe left | 24 | wipe left | 0 | 0 | 0 | 0 |
| 24 | still | wipe down | 12 | wipe down | 0 | 0 | 0 | 0 |
| 24 | still | wipe down | 24 | wipe down | 0 | 0 | 0 | 0 |
| 24 | moving | dissolve | 12 | dissolve | 0 | 0 | 0 | 0 |
| 24 | moving | dissolve | 24 | dissolve | 3 | 0 | 2 | 0 |
| 24 | moving | dip through black | 12 | dip black | 0 | 0 | 0 | 0 |
| 24 | moving | dip through black | 24 | dip black | 0 | 0 | 0 | 0 |
| 24 | moving | dip through white | 12 | dip white | 0 | 0 | 0 | 0 |
| 24 | moving | dip through white | 24 | dip white | 0 | 0 | 0 | 0 |
| 24 | moving | wipe left | 12 | wipe left | -1 | 0 | 0 | 0 |
| 24 | moving | wipe left | 24 | wipe left | -1 | 0 | 0 | 0 |
| 24 | moving | wipe down | 12 | wipe down | -1 | 0 | 0 | 0 |
| 24 | moving | wipe down | 24 | wipe down | -1 | 0 | 0 | 0 |
| 30 | still | dissolve | 12 | dissolve | 0 | 0 | 0 | 0 |
| 30 | still | dissolve | 24 | dissolve | 0 | 0 | 0 | 0 |
| 30 | still | dip through black | 12 | dip black | 0 | 0 | 0 | 0 |
| 30 | still | dip through black | 24 | dip black | 0 | 0 | 0 | 0 |
| 30 | still | dip through white | 12 | dip white | 0 | 0 | 0 | 0 |
| 30 | still | dip through white | 24 | dip white | 0 | 0 | 0 | 0 |
| 30 | still | wipe left | 12 | wipe left | 0 | 0 | 0 | 0 |
| 30 | still | wipe left | 24 | wipe left | 0 | 0 | 0 | 0 |
| 30 | still | wipe down | 12 | wipe down | 0 | 0 | 0 | 0 |
| 30 | still | wipe down | 24 | wipe down | 0 | 0 | 0 | 0 |
| 30 | moving | dissolve | 12 | dissolve | 0 | 0 | 0 | 0 |
| 30 | moving | dissolve | 24 | dissolve | 0 | 0 | 0 | 0 |
| 30 | moving | dip through black | 12 | dip black | 0 | 0 | 0 | 0 |
| 30 | moving | dip through black | 24 | dip black | 0 | 0 | 0 | 0 |
| 30 | moving | dip through white | 12 | dip white | 0 | 0 | 0 | 0 |
| 30 | moving | dip through white | 24 | dip white | 0 | 0 | 0 | 0 |
| 30 | moving | wipe left | 12 | wipe left | -1 | 0 | 0 | 0 |
| 30 | moving | wipe left | 24 | wipe left | -1 | 0 | 0 | 0 |
| 30 | moving | wipe down | 12 | wipe down | -1 | 0 | 0 | 0 |
| 30 | moving | wipe down | 24 | wipe down | -1 | 0 | 0 | 0 |
| 60 | still | dissolve | 12 | dissolve | 0 | 0 | 0 | 0 |
| 60 | still | dissolve | 24 | dissolve | 0 | 0 | 0 | 0 |
| 60 | still | dip through black | 12 | dip black | 0 | 0 | 0 | 0 |
| 60 | still | dip through black | 24 | dip black | 0 | 0 | 0 | 0 |
| 60 | still | dip through white | 12 | dip white | 0 | 0 | 0 | 0 |
| 60 | still | dip through white | 24 | dip white | 0 | 0 | 0 | 0 |
| 60 | still | wipe left | 12 | wipe left | 0 | 0 | 0 | 0 |
| 60 | still | wipe left | 24 | wipe left | 0 | 0 | 0 | 0 |
| 60 | still | wipe down | 12 | wipe down | 0 | 0 | 0 | 0 |
| 60 | still | wipe down | 24 | wipe down | 0 | 0 | 0 | 0 |
| 60 | moving | dissolve | 12 | dissolve | 0 | 0 | 0 | 0 |
| 60 | moving | dissolve | 24 | dissolve | 0 | 0 | 0 | 0 |
| 60 | moving | dip through black | 12 | dip black | 0 | 0 | 0 | 0 |
| 60 | moving | dip through black | 24 | dip black | 0 | 0 | 0 | 0 |
| 60 | moving | dip through white | 12 | dip white | 0 | 0 | 0 | 0 |
| 60 | moving | dip through white | 24 | dip white | 0 | 0 | 0 | 0 |
| 60 | moving | wipe left | 12 | wipe left | 0 | 0 | 0 | 0 |
| 60 | moving | wipe left | 24 | wipe left | 0 | 0 | 0 | 0 |
| 60 | moving | wipe down | 12 | wipe down | 0 | 0 | 0 | 0 |
| 60 | moving | wipe down | 24 | wipe down | 0 | 0 | 0 | 0 |

</details>

## Tracked curves (`track`)

A 70×70 px square on a 640×360 frame travels 380 px with a known timing curve: four cubic-beziers (CSS `ease`,
`ease-in-out`, a custom `cubic-bezier(0.7, 0.1, 0.2, 0.95)` and an overshooting back-out) over 0.5 s, and two
damped springs (stiffness/damping 170/12 and 100/10, mass 1), at 24, 30 and 60 fps. Frames are rendered with
antialiasing and encoded as H.264: clean, with pixel noise, and over a busy textured background with noise. `track`
finds the square on its own (`element: auto`) and fits its x curve. 54 clips.

| Condition | Model chosen right | Shape error, mean / max | Bezier control points, mean / max error | Duration error, mean / max (frames) | Start error, mean / max (frames) | Spring stiffness / damping, mean error |
|---|---|---|---|---|---|---|
| clean | 18 of 18 | 0.0 % / 0.1 % | 0.005 / 0.018 | 0.09 / 0.39 | 0.01 / 0.06 | 0.0 % / 0.0 % |
| noise σ=4 | 18 of 18 | 0.0 % / 0.0 % | 0.008 / 0.021 | 0.13 / 0.41 | 0.02 / 0.19 | 0.0 % / 0.0 % |
| busy background + noise σ=3 | 18 of 18 | 0.1 % / 0.4 % | 0.014 / 0.036 | 0.11 / 0.46 | 0.02 / 0.10 | 0.1 % / 0.2 % |

The shape error is the largest gap between the fitted and the true motion over time, as a share of the travel: it
covers shape and timing together, and it is the number that matters, since different control points can draw nearly
the same curve (CSS `ease-out` and a fitted `cubic-bezier(0.31, 0.51, 0.73, 1)` differ by about 1 %). Durations and
control points are also compared for the beziers; a spring is defined by its stiffness and damping, so those are
compared instead (its length on the timeline is the time it takes to settle within 0.5 % of the travel). Targets for
clean renders: duration within one frame, control points within 0.05.

### Other motion (30 fps)

Other directions, the y axis, a diagonal spring, scale, a fade-in, a fade-out and a window that is mostly rest after
the move, and a move next to an identical static square (a look-alike the tracker must not jump to); clean and over
the busy background with noise. The element is found automatically except for the fade-out,
which ends invisible (a box is given). 16 clips.

| Condition | Motion | Property | Chosen | Quality | Shape error | Duration error (frames) | Start error (frames) | Spring k / c error |
|---|---|---|---|---|---|---|---|---|
| clean | left, custom bezier | x | bezier | exact | 0.0 % | -0.03 | -0.01 | — |
| clean | up, ease-in-out | y | bezier | exact | 0.0 % | -0.20 | 0.20 | — |
| clean | diagonal, spring 170/12 | x | spring | exact | 0.0 % | — | 0.00 | 0.1 % / 0.1 % |
| clean | scale 1 → 1.6, ease | scale | bezier | exact | 0.7 % | -0.71 | -0.04 | — |
| clean | fade in, ease-in-out | opacity | bezier | exact | 0.1 % | 0.13 | -0.07 | — |
| clean | fade out (box given), ease | opacity | bezier | exact | 0.4 % | -0.83 | 0.15 | — |
| clean | right, then 1.5 s of rest | x | bezier | exact | 0.0 % | -0.09 | 0.00 | — |
| clean | right, identical twin 110 px above the start | x | bezier | exact | 0.0 % | 0.02 | 0.00 | — |
| busy background + noise σ=3 | left, custom bezier | x | bezier | exact | 0.0 % | 0.05 | -0.02 | — |
| busy background + noise σ=3 | up, ease-in-out | y | bezier | exact | 0.0 % | 0.01 | 0.02 | — |
| busy background + noise σ=3 | diagonal, spring 170/12 | x | spring | exact | 0.1 % | — | 0.00 | 0.1 % / 0.2 % |
| busy background + noise σ=3 | scale 1 → 1.6, ease | scale | bezier | exact | 0.6 % | 0.20 | 0.19 | — |
| busy background + noise σ=3 | fade in, ease-in-out | opacity | bezier | approximate | 0.7 % | -1.02 | 0.39 | — |
| busy background + noise σ=3 | fade out (box given), ease | opacity | bezier | approximate | 0.9 % | -1.24 | 0.28 | — |
| busy background + noise σ=3 | right, then 1.5 s of rest | x | bezier | exact | 0.0 % | -0.01 | -0.00 | — |
| busy background + noise σ=3 | right, identical twin 110 px above the start | x | bezier | exact | 0.1 % | -0.36 | 0.03 | — |

Scale is measured to about 1–2 % of its value and opacity from the element's brightness against its surroundings, so
their curves are less exact than position (here the duration of a scale or opacity move is off by up to about 1.3
frames, while position stays within a frame): read the shape error above, and the fit error `track` reports.
Springs with a damping ratio of about 0.85 or more barely overshoot (under 1 % of the travel): they are reported as
the cubic-bezier that matches them within the stated error, not as a spring. Moves of 5 frames or fewer are marked
unreliable: too short to tell curves apart. Grades: `exact` needs a fit error within 1 % of the travel, sample
noise within 0.4 % of it and at least 8 moving frames; `approximate` within 3 % and 1.5 %; opacity read against a
busy surrounding is at best approximate (a fade-out that ends invisible is measured against the background it leaves,
which removes the surrounding's bias; its noise can still keep it approximate). A 6-frame move is therefore graded approximate even when it is fitted closely.

Limits: these renders are a sharp-edged square without motion blur, moving in a straight line over a static
background. Real footage adds motion blur, rotation, occlusion, a moving camera and elements that change shape; the
tracker follows position, size and brightness only, and the fit error it reports for each property is the honest
measure of how well the curve explains that footage.

<details><summary>Every tracked clip</summary>

| fps | condition | curve | chosen | fitted | shape error | control error | duration error (frames) | start error (frames) | fit error |
|---|---|---|---|---|---|---|---|---|---|
| 24 | clean | ease | bezier | cubic-bezier(0.2536, 0.1036, 0.2555, 0.9817) | 0.0 % | 0.018 | -0.27 | 0.01 | 0.0 % |
| 24 | clean | ease-in-out | bezier | cubic-bezier(0.4194, 0, 0.5813, 1) | 0.0 % | 0.001 | -0.01 | 0.00 | 0.0 % |
| 24 | clean | custom | bezier | cubic-bezier(0.6984, 0.1005, 0.1992, 0.9515) | 0.1 % | 0.002 | 0.00 | 0.01 | 0.0 % |
| 24 | clean | overshoot (back-out) | bezier | cubic-bezier(0.3397, 1.5602, 0.6409, 1) | 0.0 % | 0.001 | 0.00 | 0.00 | 0.0 % |
| 24 | clean | spring 170/12 (bouncy) | spring | stiffness 170.01, damping 12.002 | 0.0 % | — | — | 0.00 | 0.0 % |
| 24 | clean | spring 100/10 (Remotion default) | spring | stiffness 100.13, damping 10.013 | 0.0 % | — | — | 0.00 | 0.0 % |
| 24 | noise σ=4 | ease | bezier | cubic-bezier(0.2524, 0.1029, 0.2538, 0.9874) | 0.0 % | 0.013 | -0.19 | 0.01 | 0.0 % |
| 24 | noise σ=4 | ease-in-out | bezier | cubic-bezier(0.4194, 0.0078, 0.582, 0.9864) | 0.0 % | 0.014 | -0.16 | 0.06 | 0.0 % |
| 24 | noise σ=4 | custom | bezier | cubic-bezier(0.7004, 0.1006, 0.2006, 0.9495) | 0.0 % | 0.001 | -0.01 | 0.00 | 0.0 % |
| 24 | noise σ=4 | overshoot (back-out) | bezier | cubic-bezier(0.3399, 1.56, 0.6416, 0.9999) | 0.0 % | 0.002 | -0.01 | 0.00 | 0.0 % |
| 24 | noise σ=4 | spring 170/12 (bouncy) | spring | stiffness 170, damping 12.003 | 0.0 % | — | — | 0.00 | 0.0 % |
| 24 | noise σ=4 | spring 100/10 (Remotion default) | spring | stiffness 100.04, damping 10.008 | 0.0 % | — | — | 0.00 | 0.0 % |
| 24 | busy background + noise σ=3 | ease | bezier | cubic-bezier(0.2476, 0.136, 0.2557, 1) | 0.4 % | 0.036 | -0.10 | 0.10 | 0.0 % |
| 24 | busy background + noise σ=3 | ease-in-out | bezier | cubic-bezier(0.4191, 0, 0.5773, 1) | 0.1 % | 0.003 | 0.00 | 0.01 | 0.0 % |
| 24 | busy background + noise σ=3 | custom | bezier | cubic-bezier(0.702, 0.0949, 0.1996, 0.9533) | 0.1 % | 0.005 | 0.09 | -0.05 | 0.0 % |
| 24 | busy background + noise σ=3 | overshoot (back-out) | bezier | cubic-bezier(0.3395, 1.5267, 0.6397, 1.0245) | 0.1 % | 0.033 | -0.24 | 0.00 | 0.0 % |
| 24 | busy background + noise σ=3 | spring 170/12 (bouncy) | spring | stiffness 169.85, damping 11.983 | 0.0 % | — | — | -0.00 | 0.0 % |
| 24 | busy background + noise σ=3 | spring 100/10 (Remotion default) | spring | stiffness 99.87, damping 9.975 | 0.1 % | — | — | 0.00 | 0.0 % |
| 30 | clean | ease | bezier | cubic-bezier(0.2496, 0.0996, 0.2492, 1.0016) | 0.0 % | 0.002 | 0.04 | 0.00 | 0.0 % |
| 30 | clean | ease-in-out | bezier | cubic-bezier(0.421, 0, 0.583, 0.9828) | 0.0 % | 0.017 | -0.16 | 0.00 | 0.0 % |
| 30 | clean | custom | bezier | cubic-bezier(0.6998, 0.0993, 0.1995, 0.9503) | 0.0 % | 0.001 | 0.01 | -0.00 | 0.0 % |
| 30 | clean | overshoot (back-out) | bezier | cubic-bezier(0.3401, 1.5541, 0.6412, 1.0042) | 0.0 % | 0.006 | -0.07 | 0.00 | 0.0 % |
| 30 | clean | spring 170/12 (bouncy) | spring | stiffness 170.1, damping 12.007 | 0.0 % | — | — | 0.00 | 0.0 % |
| 30 | clean | spring 100/10 (Remotion default) | spring | stiffness 99.98, damping 9.996 | 0.0 % | — | — | 0.00 | 0.0 % |
| 30 | noise σ=4 | ease | bezier | cubic-bezier(0.2512, 0.0991, 0.2518, 0.9927) | 0.0 % | 0.007 | -0.13 | 0.00 | 0.0 % |
| 30 | noise σ=4 | ease-in-out | bezier | cubic-bezier(0.417, 0.0212, 0.5801, 0.9911) | 0.0 % | 0.021 | -0.27 | 0.19 | 0.0 % |
| 30 | noise σ=4 | custom | bezier | cubic-bezier(0.7011, 0.0994, 0.2012, 0.9485) | 0.0 % | 0.001 | -0.02 | -0.01 | 0.0 % |
| 30 | noise σ=4 | overshoot (back-out) | bezier | cubic-bezier(0.3402, 1.5447, 0.6414, 1.0107) | 0.0 % | 0.015 | -0.16 | 0.00 | 0.0 % |
| 30 | noise σ=4 | spring 170/12 (bouncy) | spring | stiffness 170.02, damping 12.004 | 0.0 % | — | — | 0.00 | 0.0 % |
| 30 | noise σ=4 | spring 100/10 (Remotion default) | spring | stiffness 99.98, damping 9.998 | 0.0 % | — | — | 0.00 | 0.0 % |
| 30 | busy background + noise σ=3 | ease | bezier | cubic-bezier(0.2495, 0.1261, 0.2481, 1.0073) | 0.2 % | 0.026 | 0.09 | 0.08 | 0.0 % |
| 30 | busy background + noise σ=3 | ease-in-out | bezier | cubic-bezier(0.4208, 0, 0.5785, 1) | 0.0 % | 0.001 | 0.01 | -0.01 | 0.0 % |
| 30 | busy background + noise σ=3 | custom | bezier | cubic-bezier(0.7002, 0.096, 0.2011, 0.9523) | 0.0 % | 0.004 | 0.03 | -0.02 | 0.0 % |
| 30 | busy background + noise σ=3 | overshoot (back-out) | bezier | cubic-bezier(0.3401, 1.5394, 0.6428, 1.0158) | 0.1 % | 0.021 | -0.22 | 0.00 | 0.0 % |
| 30 | busy background + noise σ=3 | spring 170/12 (bouncy) | spring | stiffness 169.76, damping 11.975 | 0.1 % | — | — | 0.00 | 0.0 % |
| 30 | busy background + noise σ=3 | spring 100/10 (Remotion default) | spring | stiffness 99.9, damping 9.978 | 0.1 % | — | — | 0.00 | 0.0 % |
| 60 | clean | ease | bezier | cubic-bezier(0.2517, 0.1028, 0.2532, 0.9895) | 0.0 % | 0.010 | -0.39 | 0.02 | 0.0 % |
| 60 | clean | ease-in-out | bezier | cubic-bezier(0.4197, 0.0038, 0.58, 1) | 0.0 % | 0.004 | -0.06 | 0.06 | 0.0 % |
| 60 | clean | custom | bezier | cubic-bezier(0.7007, 0.1001, 0.2009, 0.949) | 0.0 % | 0.001 | -0.04 | -0.01 | 0.0 % |
| 60 | clean | overshoot (back-out) | bezier | cubic-bezier(0.3398, 1.5602, 0.6401, 1) | 0.0 % | 0.000 | 0.01 | 0.00 | 0.0 % |
| 60 | clean | spring 170/12 (bouncy) | spring | stiffness 170.03, damping 12.003 | 0.0 % | — | — | 0.00 | 0.0 % |
| 60 | clean | spring 100/10 (Remotion default) | spring | stiffness 100.01, damping 10 | 0.0 % | — | — | 0.00 | 0.0 % |
| 60 | noise σ=4 | ease | bezier | cubic-bezier(0.252, 0.0993, 0.2535, 0.9892) | 0.0 % | 0.011 | -0.41 | 0.00 | 0.0 % |
| 60 | noise σ=4 | ease-in-out | bezier | cubic-bezier(0.4182, 0.0086, 0.579, 1) | 0.0 % | 0.009 | -0.15 | 0.16 | 0.0 % |
| 60 | noise σ=4 | custom | bezier | cubic-bezier(0.7007, 0.0999, 0.2007, 0.9492) | 0.0 % | 0.001 | -0.02 | -0.01 | 0.0 % |
| 60 | noise σ=4 | overshoot (back-out) | bezier | cubic-bezier(0.3398, 1.5602, 0.6403, 1) | 0.0 % | 0.000 | 0.00 | 0.00 | 0.0 % |
| 60 | noise σ=4 | spring 170/12 (bouncy) | spring | stiffness 170, damping 12.002 | 0.0 % | — | — | 0.00 | 0.0 % |
| 60 | noise σ=4 | spring 100/10 (Remotion default) | spring | stiffness 100.01, damping 10.001 | 0.0 % | — | — | 0.00 | 0.0 % |
| 60 | busy background + noise σ=3 | ease | bezier | cubic-bezier(0.2507, 0.1073, 0.2483, 1) | 0.1 % | 0.007 | 0.02 | 0.04 | 0.0 % |
| 60 | busy background + noise σ=3 | ease-in-out | bezier | cubic-bezier(0.4222, 0, 0.5776, 1) | 0.1 % | 0.002 | 0.05 | -0.02 | 0.0 % |
| 60 | busy background + noise σ=3 | custom | bezier | cubic-bezier(0.7007, 0.097, 0.201, 0.9526) | 0.1 % | 0.003 | 0.03 | -0.04 | 0.0 % |
| 60 | busy background + noise σ=3 | overshoot (back-out) | bezier | cubic-bezier(0.3399, 1.5363, 0.6413, 1.0179) | 0.1 % | 0.024 | -0.46 | 0.00 | 0.0 % |
| 60 | busy background + noise σ=3 | spring 170/12 (bouncy) | spring | stiffness 169.83, damping 11.981 | 0.0 % | — | — | 0.00 | 0.0 % |
| 60 | busy background + noise σ=3 | spring 100/10 (Remotion default) | spring | stiffness 99.84, damping 9.973 | 0.1 % | — | — | 0.00 | 0.0 % |
| 30 | clean | left, custom bezier | bezier | cubic-bezier(0.7014, 0.0994, 0.2017, 0.948) | 0.0 % | 0.002 | -0.03 | -0.01 | 0.0 % |
| 30 | clean | up, ease-in-out | bezier | cubic-bezier(0.4165, 0.0233, 0.5794, 1) | 0.0 % | 0.023 | -0.20 | 0.20 | 0.0 % |
| 30 | clean | diagonal, spring 170/12 | spring | stiffness 170.1, damping 12.008 | 0.0 % | — | — | 0.00 | 0.0 % |
| 30 | clean | scale 1 → 1.6, ease | bezier | cubic-bezier(0.2605, 0.093, 0.2516, 0.9321) | 0.7 % | 0.068 | -0.71 | -0.04 | 0.3 % |
| 30 | clean | fade in, ease-in-out | bezier | cubic-bezier(0.4256, 0, 0.5744, 1) | 0.1 % | 0.006 | 0.13 | -0.07 | 0.1 % |
| 30 | clean | fade out (box given), ease | bezier | cubic-bezier(0.2578, 0.152, 0.2681, 0.9589) | 0.4 % | 0.052 | -0.83 | 0.15 | 0.1 % |
| 30 | clean | right, then 1.5 s of rest | bezier | cubic-bezier(0.2508, 0.0993, 0.2512, 0.9949) | 0.0 % | 0.005 | -0.09 | 0.00 | 0.0 % |
| 30 | clean | right, identical twin 110 px above the start | bezier | cubic-bezier(0.2498, 0.0996, 0.2494, 1.001) | 0.0 % | 0.001 | 0.02 | 0.00 | 0.0 % |
| 30 | busy background + noise σ=3 | left, custom bezier | bezier | cubic-bezier(0.7005, 0.0981, 0.199, 0.9524) | 0.0 % | 0.002 | 0.05 | -0.02 | 0.0 % |
| 30 | busy background + noise σ=3 | up, ease-in-out | bezier | cubic-bezier(0.4179, 0, 0.5803, 1.003) | 0.0 % | 0.003 | 0.01 | 0.02 | 0.0 % |
| 30 | busy background + noise σ=3 | diagonal, spring 170/12 | spring | stiffness 170.16, damping 12.021 | 0.1 % | — | — | 0.00 | 0.0 % |
| 30 | busy background + noise σ=3 | scale 1 → 1.6, ease | bezier | cubic-bezier(0.2507, 0.1697, 0.2443, 1) | 0.6 % | 0.070 | 0.20 | 0.19 | 0.2 % |
| 30 | busy background + noise σ=3 | fade in, ease-in-out | bezier | cubic-bezier(0.4425, 0.0857, 0.5961, 0.9225) | 0.7 % | 0.086 | -1.02 | 0.39 | 0.1 % |
| 30 | busy background + noise σ=3 | fade out (box given), ease | bezier | cubic-bezier(0.2682, 0.1977, 0.2442, 0.9121) | 0.9 % | 0.098 | -1.24 | 0.28 | 0.2 % |
| 30 | busy background + noise σ=3 | right, then 1.5 s of rest | bezier | cubic-bezier(0.2503, 0.0976, 0.2494, 0.9996) | 0.0 % | 0.002 | -0.01 | -0.00 | 0.0 % |
| 30 | busy background + noise σ=3 | right, identical twin 110 px above the start | bezier | cubic-bezier(0.2518, 0.106, 0.2566, 0.982) | 0.1 % | 0.018 | -0.36 | 0.03 | 0.0 % |

</details>
