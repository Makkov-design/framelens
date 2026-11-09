# Frame Lens 2.1 demo — spec

GOAL:    a developer sees Frame Lens read a real trailer's cuts to the frame, then sees a move we animated
         measured back exactly, and leaves with the install command and the site.
OUTPUT:  HyperFrames 0.9.9, 1920 x 1080, 30 fps.
TIME:    28.6 s x 30 = 858 frames. Music bed without beats; the cuts and moves are the clock.
LOOK:    the site's chroma-key style (docs/tokens.css): field green oklch(82% 0.2 142) as the ground,
         ink oklch(21% 0.035 155) for every word and line, record red oklch(58% 0.22 27) only on
         measurements (cut ticks, the tracked squares, measured values, the Star button);
         paper oklch(97.5% 0.012 135) for the palette beat, the ink band for the code beat.
         Panchang 700 for heads (56 px scene heads, 124 px opening head), General Sans 400/600 for labels
         (28 px minimum), JetBrains Mono for every measured value and command (28-52 px).
         No shadows, no gradients, 14 px card radius, 2 px ink rules.
OBJECTS: real frames of the Big Buck Bunny trailer (docs/assets/bbb, CC BY 3.0, Blender Foundation);
         Frame Lens's reading of it (docs/assets/bbb/reading.js: cut times, palettes); two red squares whose
         moves are known curves; Frame Lens's own track and export of this film (CHECK.md); the site's icon.
MOTION:  arrivals: per-word or whole-line blur-in, 0.13-0.2 s power2.out, no translate;
         chips and the button: scale 0.7/0.85 -> 1, 0.3 s expo.out; the playhead: linear (progress);
         the proof squares: cubic-bezier(0.22, 1, 0.36, 1) over 18 frames, and a closed-form spring
         (stiffness 170, damping 12, mass 1) over 1.2 s; exits: 0.16-0.18 s blur-out.
SHOTS (absolute seconds):
  0.00-2.80  title. Wordmark at frame 0; "Video your agent can measure" per word, lead line at 0.77 s. Hard cut.
  2.80-9.80  loupe. One real frame per trailer shot; the playhead sweeps the 33 s trailer in 5.94 s
             (0.18 s per trailer second, from 3.20 s). At each measured cut the frame swaps and a red tick
             drops on the ruler, on whole frames: frames 145, 156, 168, 171, 177, 183, 186, 231, 237, 258, 264.
             Readout counts trailer time, trailer frame, shot, cuts (to 11). Sound: one clock tick per cut. Hard cut.
  9.80-17.00 proof. "We animate it. Frame Lens measures it." Square A holds, moves 640 px on the ease-out from
             10.60 to 11.20 s, holds (wood tap on landing); its chart draws the animated curve, then the measured
             one dashes over it with the values. Square B holds, springs 640 px from 12.80 s (click on release),
             holds; same chart and values. Data: the CURVES object in compositions/proof.html. Hard cut.
  17.00-20.00 palette. Shot 10's frame; its four measured colours land (clicks), then the whole trailer's top
             six by share. Hard cut.
  20.00-24.60 code. "Both moves, exported to five renderers": the CSS export line of the ease-out arrives
             (keys), 22.40 the Remotion tab is chosen and the spring's entry arrives. Hard cut.
  24.60-28.60 end. The icon lands, its record dot lights, the wordmark wipes out of it; the command
             `npx -y framelens init`, the Star on GitHub button (click), makkov-design.github.io/framelens,
             "Free, local and MIT. Works in any MCP client." Holds 2.8 s.
BANNED:  invented numbers or claims; the trailer reading's 26.04 s "move" (it is a cut, a fade and a logo
         scale-in, not one move); a dark void ground; glow, gradients, glass; everything centred; titles that
         move after landing; three cards in a row; the logo docked in a corner; a typing prompt box as the opener.
QA:      5.5 and 9.5 (loupe frame and ticks), 11.0 and 16.0 (proof mid-move and complete), 18.5 (palette),
         21.2 and 23.6 (both code tabs), 28.3 (end card). Self-measure with Frame Lens: CHECK.md.
SOUND:   bed "Plathe (Beatless Ambient Mix)" by POA (CC BY 3.0) at 0.22 from 4 s into the file, fades
         0.4 s / 1.6 s; real recordings from Openverse for every effect (credits: docs/assets/demo/CREDITS.md).
