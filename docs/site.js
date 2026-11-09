// Frame Lens site: the loupe over the measured trailer, tab switchers and copy buttons.
// Without JavaScript every panel shows in order and the loupe shows one measured moment.
(() => {
  'use strict';

  // Switchers: arrow keys move between tabs; panels stay visible when this script does not run.
  for (const sw of document.querySelectorAll('[data-switch]')) {
    const tabs = [...sw.querySelectorAll('[role="tab"]')];
    const select = (tab, focus) => {
      for (const t of tabs) {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        const panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = !on;
      }
      if (focus) tab.focus();
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => select(tab, false));
      tab.addEventListener('keydown', (e) => {
        const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (e.key === 'Home') { e.preventDefault(); select(tabs[0], true); }
        else if (e.key === 'End') { e.preventDefault(); select(tabs[tabs.length - 1], true); }
        else if (step) { e.preventDefault(); select(tabs[(i + step + tabs.length) % tabs.length], true); }
      });
    });
  }

  // Copy buttons.
  for (const btn of document.querySelectorAll('[data-copy]')) {
    const label = btn.textContent;
    btn.addEventListener('click', async () => {
      const text = document.getElementById(btn.dataset.copy)?.textContent?.trim() ?? '';
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Select and copy';
      }
      setTimeout(() => { btn.textContent = label; }, 1600);
    });
  }

  // The loupe: frames every 0.5 s, the ruler drawn from the measured reading.
  const R = window.FL_READING;
  const loupe = document.querySelector('[data-loupe]');
  if (!R || !loupe) return;
  const img = loupe.querySelector('[data-loupe-img]');
  const range = loupe.querySelector('[data-loupe-range]');
  const ruler = loupe.querySelector('[data-ruler]');
  const play = loupe.querySelector('[data-loupe-play]');
  const out = (k) => loupe.querySelector(`[data-r="${k}"]`);
  const maxT = Number(range.max);
  const span = R.duration;
  const pct = (t) => `${(Math.max(0, Math.min(t, span)) / span) * 100}%`;
  const frameFile = (t) => `assets/bbb/f${String(Math.round(t / R.step) + 1).padStart(2, '0')}.webp`;

  const add = (cls, style, text) => {
    const el = document.createElement('span');
    el.className = cls;
    Object.assign(el.style, style);
    if (text) el.textContent = text;
    ruler.append(el);
    return el;
  };
  R.shots.forEach((s) => add('shot', { left: pct(s.start), width: `calc(${pct(s.end - s.start)} - 2px)`, background: s.palette[0] }));
  R.shots.slice(1).forEach((s) => add('cut', { left: pct(s.start) }));
  R.events.forEach((e) => add('move', { left: pct(e.start), width: pct(Math.max(0.3, e.end - e.start)) }));
  for (let t = 0; t <= maxT; t += 8) {
    const tick = add('tick', { left: pct(t) }, `${t} s`);
    if (t === 0) tick.style.transform = 'none';
    if (t + 8 > maxT) tick.style.transform = 'translateX(-100%)';
  }
  const head = add('head', { left: pct(Number(range.value)) });

  // Preload the frames so scrubbing does not flash.
  for (let t = 0; t <= maxT; t += R.step) { const p = new Image(); p.src = frameFile(t); }

  const show = (t) => {
    img.src = frameFile(t);
    img.alt = `Frame of the Big Buck Bunny trailer at ${t.toFixed(1)} seconds`;
    head.style.left = pct(t);
    const frame = Math.round(t * R.fps);
    out('time').textContent = `${t.toFixed(2)} s, frame ${frame}`;
    const i = R.shots.findIndex((s) => t >= s.start && t < s.end);
    const shot = R.shots[i] ?? R.shots[R.shots.length - 1];
    out('shot').textContent = `${(i < 0 ? R.shots.length - 1 : i) + 1} of ${R.shots.length}, ${(shot.end - shot.start).toFixed(2)} s`;
    const near = (e) => (t < e.start ? e.start - t : t > e.end ? t - e.end : 0);
    const move = R.events.filter((e) => near(e) <= 0.25).sort((a, b) => near(a) - near(b))[0];
    out('move').textContent = move ? `${move.easing}, ${move.frames} frames, ${move.curve}` : 'no move here';
    const pal = out('palette');
    pal.classList.remove('num');
    pal.replaceChildren(...shot.palette.map((hex) => {
      const sw = document.createElement('span');
      sw.className = 'sw';
      sw.style.setProperty('--sw', hex);
      sw.title = hex;
      return sw;
    }));
  };
  range.addEventListener('input', () => { stop(); show(Number(range.value)); });

  // Play steps through at the real rate of the samples; it stops at the end, off-screen and under reduced motion.
  let timer = 0;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const stop = () => {
    clearInterval(timer);
    timer = 0;
    play.textContent = 'Play';
    play.setAttribute('aria-pressed', 'false');
  };
  play.addEventListener('click', () => {
    if (timer) return stop();
    if (Number(range.value) >= maxT) range.value = '0';
    play.textContent = 'Pause';
    play.setAttribute('aria-pressed', 'true');
    timer = setInterval(() => {
      const next = Number(range.value) + R.step;
      if (next > maxT || reduce.matches) return stop();
      range.value = String(next);
      show(next);
    }, R.step * 1000);
  });
  new IntersectionObserver(([e]) => { if (!e.isIntersecting) stop(); }).observe(loupe);
  show(Number(range.value));
})();
