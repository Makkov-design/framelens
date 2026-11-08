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
movement's weight sits; the exact curve of an important move is best refined with `frames` every_frame.

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
