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

## Tracked curves (`track`)

A 70×70 px square on a 640×360 frame travels 380 px with a known timing curve: four cubic-beziers (CSS `ease`,
`ease-in-out`, a custom `cubic-bezier(0.7, 0.1, 0.2, 0.95)` and an overshooting back-out) over 0.5 s, and two
damped springs (stiffness/damping 170/12 and 100/10, mass 1), at 24, 30 and 60 fps. Frames are rendered with
antialiasing and encoded as H.264: clean, with pixel noise, and over a busy textured background with noise. `track`
finds the square on its own (`element: auto`) and fits its x curve. 54 clips.

| Condition | Model chosen right | Shape error, mean / max | Bezier control points, mean / max error | Duration error, mean / max (frames) | Start error, mean / max (frames) | Spring stiffness / damping, mean error |
|---|---|---|---|---|---|---|
| clean | 18 of 18 | 0.0 % / 0.1 % | 0.006 / 0.025 | 0.06 / 0.21 | 0.03 / 0.22 | 0.0 % / 0.0 % |
| noise σ=4 | 18 of 18 | 0.0 % / 0.0 % | 0.006 / 0.021 | 0.09 / 0.29 | 0.03 / 0.22 | 0.0 % / 0.0 % |
| busy background + noise σ=3 | 18 of 18 | 0.1 % / 0.4 % | 0.009 / 0.038 | 0.10 / 0.45 | 0.02 / 0.22 | 0.1 % / 0.2 % |

The shape error is the largest gap between the fitted and the true motion over time, as a share of the travel: it
covers shape and timing together, and it is the number that matters, since different control points can draw nearly
the same curve (CSS `ease-out` and a fitted `cubic-bezier(0.31, 0.51, 0.73, 1)` differ by about 1 %). Durations and
control points are also compared for the beziers; a spring is defined by its stiffness and damping, so those are
compared instead (its length on the timeline is the time it takes to settle within 0.5 % of the travel). Targets for
clean renders: duration within one frame, control points within 0.05.

### Other motion (30 fps)

Other directions, the y axis, a diagonal spring, scale, a fade-in, a fade-out and a window that is mostly rest after
the move; clean and over the busy background with noise. The element is found automatically except for the fade-out,
which ends invisible (a box is given). 14 clips.

| Condition | Motion | Property | Chosen | Quality | Shape error | Duration error (frames) | Start error (frames) | Spring k / c error |
|---|---|---|---|---|---|---|---|---|
| clean | left, custom bezier | x | bezier | exact | 0.0 % | -0.03 | -0.01 | — |
| clean | up, ease-in-out | y | bezier | exact | 0.0 % | -0.17 | 0.17 | — |
| clean | diagonal, spring 170/12 | x | spring | exact | 0.0 % | — | 0.00 | 0.1 % / 0.1 % |
| clean | scale 1 → 1.6, ease | scale | bezier | exact | 0.8 % | 2.61 | -0.03 | — |
| clean | fade in, ease-in-out | opacity | bezier | exact | 0.1 % | 0.13 | -0.07 | — |
| clean | fade out (box given), ease | opacity | bezier | exact | 0.4 % | -0.83 | 0.15 | — |
| clean | right, then 1.5 s of rest | x | bezier | exact | 0.0 % | -0.05 | 0.00 | — |
| busy background + noise σ=3 | left, custom bezier | x | bezier | exact | 0.1 % | -0.04 | -0.01 | — |
| busy background + noise σ=3 | up, ease-in-out | y | bezier | exact | 0.0 % | -0.11 | 0.12 | — |
| busy background + noise σ=3 | diagonal, spring 170/12 | x | spring | exact | 0.1 % | — | 0.00 | 0.2 % / 0.3 % |
| busy background + noise σ=3 | scale 1 → 1.6, ease | scale | bezier | exact | 0.6 % | 0.20 | 0.19 | — |
| busy background + noise σ=3 | fade in, ease-in-out | opacity | bezier | exact | 0.5 % | -1.16 | 0.74 | — |
| busy background + noise σ=3 | fade out (box given), ease | opacity | bezier | exact | 0.9 % | -1.24 | 0.28 | — |
| busy background + noise σ=3 | right, then 1.5 s of rest | x | bezier | exact | 0.0 % | -0.01 | 0.00 | — |

Scale is measured to about 1–2 % of its value and opacity from the element's brightness against its surroundings, so
their curves are less exact than position (here the duration of a scale or opacity move is off by up to about 2.6
frames, while position stays within a frame): read the shape error above, and the fit error `track` reports.
Springs with a damping ratio of about 0.85 or more barely overshoot (under 1 % of the travel): they are reported as
the cubic-bezier that matches them within the stated error, not as a spring. Moves of 5 frames or fewer are marked
unreliable: too short to tell curves apart.

Limits: these renders are a sharp-edged square without motion blur, moving in a straight line over a static
background. Real footage adds motion blur, rotation, occlusion, a moving camera and elements that change shape; the
tracker follows position, size and brightness only, and the fit error it reports for each property is the honest
measure of how well the curve explains that footage.

<details><summary>Every tracked clip</summary>

| fps | condition | curve | chosen | fitted | shape error | control error | duration error (frames) | start error (frames) | fit error |
|---|---|---|---|---|---|---|---|---|---|
| 24 | clean | ease | bezier | cubic-bezier(0.25, 0.1081, 0.2506, 1) | 0.1 % | 0.008 | -0.01 | 0.02 | 0.0 % |
| 24 | clean | ease-in-out | bezier | cubic-bezier(0.418, 0.0084, 0.5799, 1) | 0.0 % | 0.008 | -0.07 | 0.07 | 0.0 % |
| 24 | clean | custom | bezier | cubic-bezier(0.6989, 0.1003, 0.1995, 0.9509) | 0.0 % | 0.001 | 0.00 | 0.01 | 0.0 % |
| 24 | clean | overshoot (back-out) | bezier | cubic-bezier(0.3397, 1.5601, 0.641, 1) | 0.0 % | 0.001 | 0.00 | 0.00 | 0.0 % |
| 24 | clean | spring 170/12 (bouncy) | spring | stiffness 170, damping 12.003 | 0.0 % | — | — | 0.00 | 0.0 % |
| 24 | clean | spring 100/10 (Remotion default) | spring | stiffness 100.12, damping 10.014 | 0.0 % | — | — | 0.00 | 0.0 % |
| 24 | noise σ=4 | ease | bezier | cubic-bezier(0.2501, 0.1062, 0.2503, 1) | 0.0 % | 0.006 | -0.01 | 0.02 | 0.0 % |
| 24 | noise σ=4 | ease-in-out | bezier | cubic-bezier(0.4198, 0.0018, 0.5802, 0.9983) | 0.0 % | 0.002 | -0.03 | 0.01 | 0.0 % |
| 24 | noise σ=4 | custom | bezier | cubic-bezier(0.699, 0.1002, 0.1997, 0.9509) | 0.0 % | 0.001 | 0.00 | 0.01 | 0.0 % |
| 24 | noise σ=4 | overshoot (back-out) | bezier | cubic-bezier(0.3399, 1.56, 0.6414, 1) | 0.0 % | 0.001 | -0.01 | 0.00 | 0.0 % |
| 24 | noise σ=4 | spring 170/12 (bouncy) | spring | stiffness 170.01, damping 12.005 | 0.0 % | — | — | 0.00 | 0.0 % |
| 24 | noise σ=4 | spring 100/10 (Remotion default) | spring | stiffness 100.1, damping 10.012 | 0.0 % | — | — | 0.00 | 0.0 % |
| 24 | busy background + noise σ=3 | ease | bezier | cubic-bezier(0.2677, 0.1077, 0.2502, 0.9615) | 0.4 % | 0.038 | -0.45 | -0.01 | 0.1 % |
| 24 | busy background + noise σ=3 | ease-in-out | bezier | cubic-bezier(0.4183, 0, 0.5786, 1) | 0.1 % | 0.002 | -0.02 | 0.02 | 0.0 % |
| 24 | busy background + noise σ=3 | custom | bezier | cubic-bezier(0.6988, 0.0965, 0.1985, 0.9541) | 0.1 % | 0.004 | 0.04 | -0.01 | 0.0 % |
| 24 | busy background + noise σ=3 | overshoot (back-out) | bezier | cubic-bezier(0.3396, 1.5303, 0.6389, 1.0206) | 0.0 % | 0.030 | -0.22 | 0.00 | 0.0 % |
| 24 | busy background + noise σ=3 | spring 170/12 (bouncy) | spring | stiffness 170.21, damping 12.017 | 0.1 % | — | — | 0.00 | 0.1 % |
| 24 | busy background + noise σ=3 | spring 100/10 (Remotion default) | spring | stiffness 100.05, damping 9.998 | 0.1 % | — | — | 0.00 | 0.0 % |
| 30 | clean | ease | bezier | cubic-bezier(0.2494, 0.0992, 0.2495, 1.0012) | 0.0 % | 0.001 | 0.03 | 0.00 | 0.0 % |
| 30 | clean | ease-in-out | bezier | cubic-bezier(0.4162, 0.0251, 0.5778, 1) | 0.0 % | 0.025 | -0.21 | 0.22 | 0.0 % |
| 30 | clean | custom | bezier | cubic-bezier(0.6997, 0.0993, 0.1997, 0.9501) | 0.0 % | 0.001 | 0.00 | 0.00 | 0.0 % |
| 30 | clean | overshoot (back-out) | bezier | cubic-bezier(0.3402, 1.5525, 0.6406, 1.0054) | 0.0 % | 0.008 | -0.08 | 0.00 | 0.0 % |
| 30 | clean | spring 170/12 (bouncy) | spring | stiffness 170.04, damping 12.005 | 0.0 % | — | — | 0.00 | 0.0 % |
| 30 | clean | spring 100/10 (Remotion default) | spring | stiffness 100.02, damping 10 | 0.0 % | — | — | 0.00 | 0.0 % |
| 30 | noise σ=4 | ease | bezier | cubic-bezier(0.2514, 0.0993, 0.2519, 0.992) | 0.0 % | 0.008 | -0.14 | 0.00 | 0.0 % |
| 30 | noise σ=4 | ease-in-out | bezier | cubic-bezier(0.4171, 0.0213, 0.5806, 0.9886) | 0.0 % | 0.021 | -0.29 | 0.19 | 0.0 % |
| 30 | noise σ=4 | custom | bezier | cubic-bezier(0.6999, 0.0994, 0.1999, 0.9502) | 0.0 % | 0.001 | 0.01 | -0.00 | 0.0 % |
| 30 | noise σ=4 | overshoot (back-out) | bezier | cubic-bezier(0.3401, 1.5516, 0.6407, 1.0059) | 0.0 % | 0.008 | -0.09 | 0.00 | 0.0 % |
| 30 | noise σ=4 | spring 170/12 (bouncy) | spring | stiffness 170.1, damping 12.008 | 0.0 % | — | — | 0.00 | 0.0 % |
| 30 | noise σ=4 | spring 100/10 (Remotion default) | spring | stiffness 100.01, damping 10 | 0.0 % | — | — | 0.00 | 0.0 % |
| 30 | busy background + noise σ=3 | ease | bezier | cubic-bezier(0.2506, 0.0998, 0.2488, 1) | 0.0 % | 0.001 | 0.00 | 0.00 | 0.0 % |
| 30 | busy background + noise σ=3 | ease-in-out | bezier | cubic-bezier(0.4187, 0.0083, 0.5789, 1) | 0.1 % | 0.008 | -0.09 | 0.08 | 0.0 % |
| 30 | busy background + noise σ=3 | custom | bezier | cubic-bezier(0.6996, 0.0976, 0.1995, 0.952) | 0.1 % | 0.002 | 0.02 | -0.01 | 0.0 % |
| 30 | busy background + noise σ=3 | overshoot (back-out) | bezier | cubic-bezier(0.3404, 1.56, 0.6417, 1) | 0.0 % | 0.002 | -0.02 | 0.00 | 0.0 % |
| 30 | busy background + noise σ=3 | spring 170/12 (bouncy) | spring | stiffness 170.12, damping 12.008 | 0.1 % | — | — | 0.00 | 0.0 % |
| 30 | busy background + noise σ=3 | spring 100/10 (Remotion default) | spring | stiffness 100, damping 9.991 | 0.0 % | — | — | 0.00 | 0.0 % |
| 60 | clean | ease | bezier | cubic-bezier(0.25, 0.1018, 0.25, 1) | 0.0 % | 0.002 | 0.00 | 0.01 | 0.0 % |
| 60 | clean | ease-in-out | bezier | cubic-bezier(0.4185, 0.0079, 0.5791, 1) | 0.0 % | 0.008 | -0.14 | 0.15 | 0.0 % |
| 60 | clean | custom | bezier | cubic-bezier(0.7, 0.1007, 0.1998, 0.9495) | 0.0 % | 0.001 | -0.02 | 0.01 | 0.0 % |
| 60 | clean | overshoot (back-out) | bezier | cubic-bezier(0.3401, 1.5539, 0.6403, 1.0043) | 0.0 % | 0.006 | -0.13 | 0.00 | 0.0 % |
| 60 | clean | spring 170/12 (bouncy) | spring | stiffness 170.09, damping 12.007 | 0.0 % | — | — | 0.00 | 0.0 % |
| 60 | clean | spring 100/10 (Remotion default) | spring | stiffness 99.99, damping 9.999 | 0.0 % | — | — | 0.00 | 0.0 % |
| 60 | noise σ=4 | ease | bezier | cubic-bezier(0.2487, 0.1013, 0.2478, 1.0067) | 0.0 % | 0.007 | 0.26 | 0.01 | 0.0 % |
| 60 | noise σ=4 | ease-in-out | bezier | cubic-bezier(0.4177, 0.0119, 0.5789, 1) | 0.0 % | 0.012 | -0.21 | 0.22 | 0.0 % |
| 60 | noise σ=4 | custom | bezier | cubic-bezier(0.7, 0.1004, 0.1999, 0.9494) | 0.0 % | 0.001 | -0.02 | 0.01 | 0.0 % |
| 60 | noise σ=4 | overshoot (back-out) | bezier | cubic-bezier(0.3399, 1.56, 0.6404, 1) | 0.0 % | 0.000 | -0.01 | 0.00 | 0.0 % |
| 60 | noise σ=4 | spring 170/12 (bouncy) | spring | stiffness 170.05, damping 12.004 | 0.0 % | — | — | 0.00 | 0.0 % |
| 60 | noise σ=4 | spring 100/10 (Remotion default) | spring | stiffness 100, damping 9.999 | 0.0 % | — | — | 0.00 | 0.0 % |
| 60 | busy background + noise σ=3 | ease | bezier | cubic-bezier(0.2511, 0.1016, 0.2487, 1) | 0.1 % | 0.002 | -0.01 | 0.01 | 0.0 % |
| 60 | busy background + noise σ=3 | ease-in-out | bezier | cubic-bezier(0.4183, 0.0114, 0.578, 1) | 0.0 % | 0.011 | -0.21 | 0.22 | 0.0 % |
| 60 | busy background + noise σ=3 | custom | bezier | cubic-bezier(0.6993, 0.0987, 0.1984, 0.9527) | 0.1 % | 0.003 | 0.06 | 0.00 | 0.0 % |
| 60 | busy background + noise σ=3 | overshoot (back-out) | bezier | cubic-bezier(0.3393, 1.5603, 0.6442, 1) | 0.2 % | 0.004 | -0.08 | 0.01 | 0.0 % |
| 60 | busy background + noise σ=3 | spring 170/12 (bouncy) | spring | stiffness 169.75, damping 11.967 | 0.1 % | — | — | 0.00 | 0.0 % |
| 60 | busy background + noise σ=3 | spring 100/10 (Remotion default) | spring | stiffness 99.72, damping 9.958 | 0.1 % | — | — | -0.01 | 0.0 % |
| 30 | clean | left, custom bezier | bezier | cubic-bezier(0.7014, 0.0997, 0.2016, 0.9477) | 0.0 % | 0.002 | -0.03 | -0.01 | 0.0 % |
| 30 | clean | up, ease-in-out | bezier | cubic-bezier(0.4173, 0.0197, 0.5791, 1) | 0.0 % | 0.020 | -0.17 | 0.17 | 0.0 % |
| 30 | clean | diagonal, spring 170/12 | spring | stiffness 170.13, damping 12.012 | 0.0 % | — | — | 0.00 | 0.0 % |
| 30 | clean | scale 1 → 1.6, ease | bezier | cubic-bezier(0.2347, 0.1059, 0.1983, 1.1042) | 0.8 % | 0.104 | 2.61 | -0.03 | 0.2 % |
| 30 | clean | fade in, ease-in-out | bezier | cubic-bezier(0.4256, 0, 0.5744, 1) | 0.1 % | 0.006 | 0.13 | -0.07 | 0.1 % |
| 30 | clean | fade out (box given), ease | bezier | cubic-bezier(0.2578, 0.152, 0.2681, 0.9589) | 0.4 % | 0.052 | -0.83 | 0.15 | 0.1 % |
| 30 | clean | right, then 1.5 s of rest | bezier | cubic-bezier(0.2502, 0.0989, 0.2509, 0.9968) | 0.0 % | 0.003 | -0.05 | 0.00 | 0.0 % |
| 30 | busy background + noise σ=3 | left, custom bezier | bezier | cubic-bezier(0.7011, 0.0977, 0.2026, 0.9503) | 0.1 % | 0.003 | -0.04 | -0.01 | 0.0 % |
| 30 | busy background + noise σ=3 | up, ease-in-out | bezier | cubic-bezier(0.4165, 0.0127, 0.5793, 1) | 0.0 % | 0.013 | -0.11 | 0.12 | 0.0 % |
| 30 | busy background + noise σ=3 | diagonal, spring 170/12 | spring | stiffness 170.38, damping 12.037 | 0.1 % | — | — | 0.00 | 0.0 % |
| 30 | busy background + noise σ=3 | scale 1 → 1.6, ease | bezier | cubic-bezier(0.2507, 0.1697, 0.2443, 1) | 0.6 % | 0.070 | 0.20 | 0.19 | 0.2 % |
| 30 | busy background + noise σ=3 | fade in, ease-in-out | bezier | cubic-bezier(0.4203, 0.1047, 0.5774, 0.9397) | 0.5 % | 0.105 | -1.16 | 0.74 | 0.2 % |
| 30 | busy background + noise σ=3 | fade out (box given), ease | bezier | cubic-bezier(0.2682, 0.1977, 0.2442, 0.9121) | 0.9 % | 0.098 | -1.24 | 0.28 | 0.2 % |
| 30 | busy background + noise σ=3 | right, then 1.5 s of rest | bezier | cubic-bezier(0.2507, 0.0999, 0.2493, 1) | 0.0 % | 0.001 | -0.01 | 0.00 | 0.0 % |

</details>
