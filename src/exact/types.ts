import type { EasingFamily } from "../style/motion.js";

/** One animated change read from the source's own data (not measured from pixels). */
export interface ExactMove {
  /** What moves: layer name, optionally with the shape path or Figma node name. */
  target: string;
  /** position, scale, rotation, opacity, fill, stroke, transition, … */
  property: string;
  /** Seconds on the composition (or flow) timeline. */
  start: number;
  end: number;
  startFrame: number;
  endFrame: number;
  from: (number | string)[];
  to: (number | string)[];
  /** A step: the value jumps at `end` (Lottie hold keyframe). */
  hold: boolean;
  /** Control points x1,y1,x2,y2 of the curve, or undefined for springs and holds. */
  bezier?: [number, number, number, number];
  /** Exact CSS-style curve, or `spring(mass, stiffness, damping)`, or `linear` / `steps(1, end)`. */
  curve: string;
  easing: EasingFamily;
  /** Human label: "slide", "fade", "SMART_ANIMATE", … */
  type: string;
  /** For Figma: what starts it (ON_CLICK, AFTER_TIMEOUT, …). */
  trigger?: string;
  /** "measured" = read from the source data; "derived" = a named preset mapped to its usual curve. */
  evidence: "measured" | "derived";
}

export interface ExactShot {
  id: string;
  name: string;
  start: number;
  end: number;
  palette: string[];
}

export interface ExactText {
  text: string;
  family?: string;
  size?: number;
  weight?: number;
  color?: string;
  case?: string;
  where: string;
}

export interface ExactAnalysis {
  kind: "lottie" | "figma";
  title: string;
  input: string;
  url?: string;
  fps: number;
  width?: number;
  height?: number;
  start: number;
  end: number;
  shots: ExactShot[];
  moves: ExactMove[];
  /** Colours weighted by area × duration (approximate). */
  palette: { hex: string; share: number }[];
  texts: ExactText[];
  fonts: string[];
  /** Things the parser saw but could not evaluate. */
  unknowns: string[];
  layerCount: number;
}
