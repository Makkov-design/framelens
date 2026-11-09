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

| Condition | Model chosen right | Bezier control points, mean / max error | Duration error, mean / max (frames) | Start error, mean / max (frames) | Spring stiffness / damping, mean error |
|---|---|---|---|---|---|
| clean | 18 of 18 | 0.006 / 0.025 | 0.06 / 0.21 | 0.03 / 0.22 | 0.0 % / 0.0 % |
| noise σ=4 | 18 of 18 | 0.005 / 0.012 | 0.08 / 0.28 | 0.02 / 0.22 | 0.0 % / 0.0 % |
| busy background + noise σ=3 | 18 of 18 | 0.006 / 0.020 | 0.05 / 0.21 | 0.02 / 0.22 | 0.3 % / 0.5 % |

Durations and control points are compared for the beziers; a spring is defined by its stiffness and damping, so those
are compared instead (its length on the timeline is the time it takes to settle within 0.5 % of the travel). Targets
for clean renders: duration within one frame, control points within 0.05.

Limits: these renders are a sharp-edged square without motion blur, moving in a straight line over a static
background. Real footage adds motion blur, rotation, occlusion, a moving camera and elements that change shape; the
tracker follows position, size and brightness only, and the fit error it reports for each property is the honest
measure of how well the curve explains that footage.

<details><summary>Every tracked clip</summary>

| fps | condition | curve | chosen | fitted | control error | duration error (frames) | start error (frames) | fit error |
|---|---|---|---|---|---|---|---|---|
| 24 | clean | ease | bezier | cubic-bezier(0.25, 0.1081, 0.2506, 1) | 0.008 | -0.01 | 0.02 | 0.0 % |
| 24 | clean | ease-in-out | bezier | cubic-bezier(0.418, 0.0084, 0.5799, 1) | 0.008 | -0.07 | 0.07 | 0.0 % |
| 24 | clean | custom | bezier | cubic-bezier(0.6989, 0.1005, 0.1995, 0.9508) | 0.001 | 0.00 | 0.01 | 0.0 % |
| 24 | clean | overshoot (back-out) | bezier | cubic-bezier(0.34, 1.5601, 0.6414, 0.9999) | 0.001 | -0.01 | 0.00 | 0.0 % |
| 24 | clean | spring 170/12 (bouncy) | spring | stiffness 170.03, damping 11.999 | — | — | 0.00 | 0.0 % |
| 24 | clean | spring 100/10 (Remotion default) | spring | stiffness 100.04, damping 10.003 | — | — | 0.00 | 0.0 % |
| 24 | noise σ=4 | ease | bezier | cubic-bezier(0.2502, 0.1055, 0.2502, 1) | 0.005 | 0.00 | 0.01 | 0.0 % |
| 24 | noise σ=4 | ease-in-out | bezier | cubic-bezier(0.419, 0.0063, 0.5801, 0.9977) | 0.006 | -0.06 | 0.05 | 0.0 % |
| 24 | noise σ=4 | custom | bezier | cubic-bezier(0.6991, 0.1004, 0.1997, 0.9508) | 0.001 | 0.00 | 0.01 | 0.0 % |
| 24 | noise σ=4 | overshoot (back-out) | bezier | cubic-bezier(0.3399, 1.56, 0.6414, 1) | 0.001 | -0.01 | 0.00 | 0.0 % |
| 24 | noise σ=4 | spring 170/12 (bouncy) | spring | stiffness 170.08, damping 12.012 | — | — | 0.00 | 0.0 % |
| 24 | noise σ=4 | spring 100/10 (Remotion default) | spring | stiffness 100.01, damping 10.001 | — | — | 0.00 | 0.0 % |
| 24 | busy background + noise σ=3 | ease | bezier | cubic-bezier(0.2515, 0.1202, 0.2503, 1) | 0.020 | -0.03 | 0.04 | 0.0 % |
| 24 | busy background + noise σ=3 | ease-in-out | bezier | cubic-bezier(0.4183, 0.0183, 0.5759, 1.0025) | 0.018 | -0.09 | 0.13 | 0.0 % |
| 24 | busy background + noise σ=3 | custom | bezier | cubic-bezier(0.6989, 0.0965, 0.1985, 0.9538) | 0.004 | 0.04 | -0.01 | 0.0 % |
| 24 | busy background + noise σ=3 | overshoot (back-out) | bezier | cubic-bezier(0.3398, 1.5629, 0.64, 1) | 0.003 | 0.02 | 0.00 | 0.0 % |
| 24 | busy background + noise σ=3 | spring 170/12 (bouncy) | spring | stiffness 168.86, damping 11.89 | — | — | -0.01 | 0.2 % |
| 24 | busy background + noise σ=3 | spring 100/10 (Remotion default) | spring | stiffness 99.76, damping 9.967 | — | — | -0.00 | 0.0 % |
| 30 | clean | ease | bezier | cubic-bezier(0.2494, 0.0992, 0.2495, 1.0012) | 0.001 | 0.03 | 0.00 | 0.0 % |
| 30 | clean | ease-in-out | bezier | cubic-bezier(0.4162, 0.0251, 0.5778, 1) | 0.025 | -0.21 | 0.22 | 0.0 % |
| 30 | clean | custom | bezier | cubic-bezier(0.6997, 0.0993, 0.1997, 0.95) | 0.001 | 0.00 | 0.00 | 0.0 % |
| 30 | clean | overshoot (back-out) | bezier | cubic-bezier(0.3402, 1.5525, 0.6406, 1.0054) | 0.008 | -0.08 | 0.00 | 0.0 % |
| 30 | clean | spring 170/12 (bouncy) | spring | stiffness 170.12, damping 12.008 | — | — | 0.00 | 0.0 % |
| 30 | clean | spring 100/10 (Remotion default) | spring | stiffness 100.04, damping 10 | — | — | 0.00 | 0.0 % |
| 30 | noise σ=4 | ease | bezier | cubic-bezier(0.2514, 0.0993, 0.252, 0.9919) | 0.008 | -0.14 | 0.00 | 0.0 % |
| 30 | noise σ=4 | ease-in-out | bezier | cubic-bezier(0.4179, 0.0122, 0.5791, 1) | 0.012 | -0.11 | 0.11 | 0.0 % |
| 30 | noise σ=4 | custom | bezier | cubic-bezier(0.6999, 0.0994, 0.1999, 0.9501) | 0.001 | 0.01 | -0.00 | 0.0 % |
| 30 | noise σ=4 | overshoot (back-out) | bezier | cubic-bezier(0.3401, 1.556, 0.6406, 1.0028) | 0.004 | -0.04 | 0.00 | 0.0 % |
| 30 | noise σ=4 | spring 170/12 (bouncy) | spring | stiffness 170.1, damping 12.007 | — | — | 0.00 | 0.0 % |
| 30 | noise σ=4 | spring 100/10 (Remotion default) | spring | stiffness 100.01, damping 10 | — | — | 0.00 | 0.0 % |
| 30 | busy background + noise σ=3 | ease | bezier | cubic-bezier(0.2506, 0.0998, 0.2488, 1) | 0.001 | 0.00 | 0.00 | 0.0 % |
| 30 | busy background + noise σ=3 | ease-in-out | bezier | cubic-bezier(0.4201, 0, 0.5798, 1) | 0.000 | -0.02 | 0.01 | 0.0 % |
| 30 | busy background + noise σ=3 | custom | bezier | cubic-bezier(0.6995, 0.0985, 0.1983, 0.9522) | 0.002 | 0.03 | 0.00 | 0.0 % |
| 30 | busy background + noise σ=3 | overshoot (back-out) | bezier | cubic-bezier(0.3399, 1.5562, 0.641, 1.0047) | 0.005 | -0.04 | 0.00 | 0.0 % |
| 30 | busy background + noise σ=3 | spring 170/12 (bouncy) | spring | stiffness 169.61, damping 11.961 | — | — | -0.00 | 0.0 % |
| 30 | busy background + noise σ=3 | spring 100/10 (Remotion default) | spring | stiffness 99.71, damping 9.955 | — | — | -0.00 | 0.0 % |
| 60 | clean | ease | bezier | cubic-bezier(0.25, 0.1018, 0.25, 1) | 0.002 | 0.00 | 0.01 | 0.0 % |
| 60 | clean | ease-in-out | bezier | cubic-bezier(0.4183, 0.01, 0.5792, 1) | 0.010 | -0.17 | 0.18 | 0.0 % |
| 60 | clean | custom | bezier | cubic-bezier(0.7, 0.1007, 0.1998, 0.9495) | 0.001 | -0.02 | 0.01 | 0.0 % |
| 60 | clean | overshoot (back-out) | bezier | cubic-bezier(0.3401, 1.5539, 0.6403, 1.0043) | 0.006 | -0.13 | 0.00 | 0.0 % |
| 60 | clean | spring 170/12 (bouncy) | spring | stiffness 170.11, damping 12.008 | — | — | 0.00 | 0.0 % |
| 60 | clean | spring 100/10 (Remotion default) | spring | stiffness 99.99, damping 9.999 | — | — | 0.00 | 0.0 % |
| 60 | noise σ=4 | ease | bezier | cubic-bezier(0.2513, 0.1009, 0.2523, 0.9923) | 0.008 | -0.28 | 0.01 | 0.0 % |
| 60 | noise σ=4 | ease-in-out | bezier | cubic-bezier(0.4178, 0.0116, 0.5789, 1) | 0.012 | -0.20 | 0.22 | 0.0 % |
| 60 | noise σ=4 | custom | bezier | cubic-bezier(0.7, 0.1004, 0.1999, 0.9495) | 0.000 | -0.02 | 0.01 | 0.0 % |
| 60 | noise σ=4 | overshoot (back-out) | bezier | cubic-bezier(0.34, 1.5537, 0.6406, 1.0045) | 0.006 | -0.13 | 0.00 | 0.0 % |
| 60 | noise σ=4 | spring 170/12 (bouncy) | spring | stiffness 170.07, damping 12.005 | — | — | 0.00 | 0.0 % |
| 60 | noise σ=4 | spring 100/10 (Remotion default) | spring | stiffness 100.01, damping 10.001 | — | — | 0.00 | 0.0 % |
| 60 | busy background + noise σ=3 | ease | bezier | cubic-bezier(0.2508, 0.1012, 0.2487, 1) | 0.001 | -0.01 | 0.01 | 0.0 % |
| 60 | busy background + noise σ=3 | ease-in-out | bezier | cubic-bezier(0.4183, 0.0112, 0.5781, 1) | 0.011 | -0.21 | 0.22 | 0.0 % |
| 60 | busy background + noise σ=3 | custom | bezier | cubic-bezier(0.6992, 0.0991, 0.1978, 0.9527) | 0.003 | 0.06 | 0.01 | 0.0 % |
| 60 | busy background + noise σ=3 | overshoot (back-out) | bezier | cubic-bezier(0.3393, 1.5629, 0.6422, 1) | 0.003 | 0.02 | 0.01 | 0.0 % |
| 60 | busy background + noise σ=3 | spring 170/12 (bouncy) | spring | stiffness 169.68, damping 11.965 | — | — | -0.01 | 0.0 % |
| 60 | busy background + noise σ=3 | spring 100/10 (Remotion default) | spring | stiffness 99.72, damping 9.958 | — | — | -0.01 | 0.0 % |

</details>
