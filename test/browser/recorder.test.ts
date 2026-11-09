// The page-load recorder and the page reader run in a fake page (no browser needed): animations that end before the
// page is read are kept, merged with the running ones without duplicates, and the page cannot hide them by replacing
// document.getAnimations after the recorder ran.
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { cleanReading, mergeReadings, PAGE_SCRIPT, RECORDER_SCRIPT } from "../../src/browser/web.js";

type Timing = { delay?: number; duration: number; iterations?: number; easing?: string };
type Frame = { offset: number; [property: string]: unknown };

function fakePage() {
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const frames: (() => void)[] = [];
  type Effect = { target: unknown; getComputedTiming: () => Timing; getKeyframes: () => Frame[] };
  const effect = (target: unknown, timing: Timing, keyframes: Frame[]): Effect => ({
    target,
    getComputedTiming: () => ({ delay: 0, iterations: 1, easing: "linear", ...timing }),
    getKeyframes: () => keyframes,
  });
  class Animation {
    playState = "running";
    constructor(public effect: Effect) {}
    play() {
      this.playState = "running";
    }
  }
  class CSSAnimation extends Animation {
    constructor(e: Effect, public animationName: string) {
      super(e);
    }
  }
  class CSSTransition extends Animation {
    constructor(e: Effect, public transitionProperty: string) {
      super(e);
    }
  }
  const all: Element[] = [];
  class Element {
    tagName = "DIV";
    id = "";
    parentElement = null;
    classList: string[];
    animations: Animation[] = [];
    constructor(name: string) {
      this.classList = [name];
      all.push(this);
    }
    getAnimations() {
      return this.animations.filter((a) => a.playState === "running" || a.playState === "paused");
    }
    animate(keyframes: Frame[], options: Timing) {
      const a = new Animation(effect(this, options, keyframes));
      this.animations.push(a);
      return a;
    }
  }
  class Document {
    title = "Fake";
    documentElement = { scrollHeight: 900 };
    getAnimations() {
      return all.flatMap((e) => e.getAnimations());
    }
    querySelectorAll() {
      return [];
    }
  }
  const document = new Document();
  const page: Record<string, unknown> = {
    Animation,
    Element,
    Document,
    document,
    performance: { now: () => 0 },
    requestAnimationFrame: (f: () => void) => frames.push(f),
    addEventListener: (type: string, fn: (event: unknown) => void) => (listeners[type] ??= []).push(fn),
    scrollY: 0,
    innerWidth: 1440,
    innerHeight: 900,
    location: { href: "https://example.test/" },
    getComputedStyle: () => ({}),
  };
  page.window = page;
  const context = createContext(page);
  return {
    page,
    document,
    run: (script: string) => runInContext(script, context),
    fire: (type: string, target: Element) => (listeners[type] ?? []).forEach((fn) => fn({ type, target })),
    tick: () => frames.splice(0).forEach((f) => f()),
    element: (name: string) => new Element(name),
    css: (el: Element, name: string, timing: Timing) => {
      const a = new CSSAnimation(effect(el, timing, [{ offset: 0, easing: "cubic-bezier(0.22, 1, 0.36, 1)", transform: "translateY(40px)" }, { offset: 1, transform: "none" }]), name);
      el.animations.push(a);
      return a;
    },
    transition: (el: Element, property: string, timing: Timing) => {
      const a = new CSSTransition(effect(el, timing, [{ offset: 0, [property]: "0" }, { offset: 1, [property]: "1" }]), property);
      el.animations.push(a);
      return a;
    },
  };
}

describe("the page-load recorder", () => {
  it("keeps animations that ended before the reading, next to the running ones, each once", () => {
    const p = fakePage();
    p.run(RECORDER_SCRIPT);
    // A CSS animation without fill-mode (650 ms after 100 ms), a transition set on load, a later one with a delay,
    // a Web Animation, and one transition that is still running when the page is read.
    const b = p.element("b");
    const rise = p.css(b, "rise", { duration: 650, delay: 100 });
    p.fire("animationstart", b);
    const f = p.element("f");
    const fade = p.transition(f, "opacity", { duration: 500 });
    p.fire("transitionrun", f);
    const late = p.element("late");
    const lateFade = p.transition(late, "opacity", { duration: 450, delay: 100 });
    p.fire("transitionrun", late);
    p.fire("transitionstart", late);
    const box = p.element("box");
    const waapi = (box as unknown as { animate: (k: Frame[], o: Timing) => { playState: string } }).animate.call(box, [{ offset: 0, opacity: "0" }, { offset: 1, opacity: "1" }], { duration: 300, easing: "ease-in" });
    const still = p.element("still");
    p.transition(still, "transform", { duration: 2000 });
    p.fire("transitionrun", still);
    p.tick();
    for (const a of [rise, fade, lateFade, waapi]) a.playState = "finished";

    const reading = mergeReadings([cleanReading(p.run(PAGE_SCRIPT))]);
    const byTarget = (cls: string) => reading.animations.filter((a) => a.target === `div.${cls}`);
    expect(reading.animations).toHaveLength(5);
    expect(byTarget("b")).toEqual([expect.objectContaining({ kind: "css-animation", name: "rise", duration: 650, delay: 100, ended: true })]);
    expect(byTarget("f")).toEqual([expect.objectContaining({ kind: "css-transition", name: "opacity", duration: 500, ended: true })]);
    expect(byTarget("late")).toEqual([expect.objectContaining({ kind: "css-transition", duration: 450, delay: 100, ended: true })]);
    expect(byTarget("box")).toEqual([expect.objectContaining({ kind: "waapi", duration: 300, easing: "ease-in", ended: true })]);
    expect(byTarget("still")).toHaveLength(1);
    expect(byTarget("still")[0]!.ended).toBeUndefined();
  });

  it("still sees animations when the page replaces document.getAnimations after it", () => {
    const p = fakePage();
    p.run(RECORDER_SCRIPT);
    (p.document as unknown as { getAnimations: () => never }).getAnimations = () => {
      throw new Error("hidden");
    };
    const el = p.element("hero");
    const a = p.css(el, "intro", { duration: 400 });
    p.tick(); // the per-frame sample uses the browser's own getAnimations, kept before the page ran
    a.playState = "finished";
    const reading = cleanReading(p.run(PAGE_SCRIPT));
    expect(reading.animations).toEqual([expect.objectContaining({ name: "intro", duration: 400, ended: true })]);
  });

  it("installs once and reads a page without a recorder as before", () => {
    const p = fakePage();
    p.run(RECORDER_SCRIPT);
    p.run(RECORDER_SCRIPT);
    const el = p.element("x");
    (el as unknown as { animate: (k: Frame[], o: Timing) => unknown }).animate([{ offset: 0, opacity: "0" }, { offset: 1, opacity: "1" }], { duration: 200 });
    expect(cleanReading(p.run(PAGE_SCRIPT)).animations).toHaveLength(1);

    const plain = fakePage();
    plain.css(plain.element("y"), "spin", { duration: 1000, iterations: Infinity });
    const reading = cleanReading(plain.run(PAGE_SCRIPT));
    expect(reading.animations).toEqual([expect.objectContaining({ name: "spin", iterations: "infinite" })]);
    expect(reading.animations[0]!.ended).toBeUndefined();
  });
});
