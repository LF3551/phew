import type { AvatarLook } from "../core/persona";

/**
 * The Phew family. Every look is the same living mascot (the eyes blink, look around and sleep),
 * with its own silhouette, colors and a few details. All drawings stay inside the 256 × 256 box.
 */

type Shape = readonly [tag: "path" | "rect" | "circle" | "ellipse", attributes: Record<string, string>];

export interface LookArt {
  readonly label: string;
  /** Colors of the face, the eyes and the details. */
  readonly face: string;
  readonly eye: string;
  /** The silhouette. Empty means the classic rounded square. */
  readonly body?: Shape;
  /** Details under and over the eyes. */
  readonly back?: readonly Shape[];
  readonly front?: readonly Shape[];
  /** Makes the eyes smaller around this point, for faces with less room. */
  readonly eyeScale?: number;
  /** Keeps the drop of sweat. */
  readonly drop?: boolean;
}

const blush = (color: string): Shape[] => [
  ["ellipse", { cx: "58", cy: "196", rx: "20", ry: "11", fill: color }],
  ["ellipse", { cx: "198", cy: "196", rx: "20", ry: "11", fill: color }],
];

export const lookArt: Readonly<Record<AvatarLook, LookArt>> = {
  cat: {
    label: "Cat",
    face: "#f4c99b",
    eye: "#3b2a1e",
    body: [
      "path",
      {
        d: "M30 96 36 18q2-12 12-6l62 38h36l62-38q10-6 12 6l6 78q20 26 20 66v24q0 70-70 70H86q-70 0-70-70v-24q0-40 14-66z",
      },
    ],
    back: [
      ["path", { d: "M50 40 54 82 86 58z", fill: "#e8957f" }],
      ["path", { d: "M206 40 202 82 170 58z", fill: "#e8957f" }],
      ...blush("#ee9f86"),
    ],
    front: [
      [
        "path",
        {
          d: "M118 186h20l-10 11z",
          fill: "#d9776a",
          stroke: "#d9776a",
          "stroke-width": "6",
          "stroke-linejoin": "round",
        },
      ],
    ],
  },
  bot: {
    label: "Bot",
    face: "#c9d4e2",
    eye: "#6ff2cf",
    body: ["rect", { x: "14", y: "50", width: "228", height: "206", rx: "60" }],
    back: [
      ["path", { d: "M128 52V24", stroke: "#c9d4e2", "stroke-width": "12", "stroke-linecap": "round" }],
      ["circle", { cx: "128", cy: "20", r: "15", fill: "#ff7a6b" }],
      ["rect", { x: "0", y: "124", width: "20", height: "58", rx: "8", fill: "#9fb0c6" }],
      ["rect", { x: "236", y: "124", width: "20", height: "58", rx: "8", fill: "#9fb0c6" }],
      ["rect", { x: "36", y: "96", width: "184", height: "112", rx: "40", fill: "#1f2733" }],
    ],
    eyeScale: 0.78,
  },
  ghost: {
    label: "Ghost",
    face: "#ece9ff",
    eye: "#3a3466",
    body: [
      "path",
      {
        d: "M14 128a114 114 0 0 1 228 0v100q0 26-22 12l-22-14-26 22-26-22-24 22-24-22-26 22-26-22-22 14q-22 14-22-12z",
      },
    ],
    back: blush("#ffc2d6"),
  },
  sprout: {
    label: "Sprout",
    face: "#bfe8c6",
    eye: "#21412a",
    body: ["rect", { x: "0", y: "48", width: "256", height: "208", rx: "72" }],
    back: [
      ["path", { d: "M128 52V26", stroke: "#3fa35f", "stroke-width": "10", "stroke-linecap": "round" }],
      ["path", { d: "M128 30C114 4 84 2 70 12c12 24 38 32 58 18z", fill: "#56c477" }],
      ["path", { d: "M128 30c14-26 44-28 58-18-12 24-38 32-58 18z", fill: "#3fa35f" }],
      ...blush("#9fd8a9"),
    ],
  },
  nerd: {
    label: "Nerd",
    face: "#f7d68c",
    eye: "#33291a",
    back: [
      ["circle", { cx: "80", cy: "148", r: "48", fill: "#fff8e6" }],
      ["circle", { cx: "176", cy: "148", r: "48", fill: "#fff8e6" }],
    ],
    // The frames are over the eyes, like real glasses.
    front: [
      ["circle", { cx: "80", cy: "148", r: "48", fill: "none", stroke: "#33291a", "stroke-width": "11" }],
      ["circle", { cx: "176", cy: "148", r: "48", fill: "none", stroke: "#33291a", "stroke-width": "11" }],
      [
        "path",
        { d: "M124 136q4-6 8 0", fill: "none", stroke: "#33291a", "stroke-width": "11", "stroke-linecap": "round" },
      ],
    ],
    eyeScale: 0.8,
    drop: true,
  },
  night: {
    label: "Night owl",
    face: "#28314b",
    eye: "#f3efe6",
    back: [
      ["path", { d: "M198 26q4 24 26 28-22 4-26 28-4-24-26-28 22-4 26-28z", fill: "#ffd166" }],
      ["circle", { cx: "160", cy: "40", r: "6", fill: "#ffd166", opacity: "0.7" }],
      ["circle", { cx: "226", cy: "92", r: "5", fill: "#ffd166", opacity: "0.5" }],
    ],
  },
  angel: {
    label: "Angel",
    face: "#fff3df",
    eye: "#3d3426",
    body: ["rect", { x: "0", y: "52", width: "256", height: "204", rx: "72" }],
    back: [
      ["ellipse", { cx: "128", cy: "24", rx: "66", ry: "15", fill: "none", stroke: "#ffc94d", "stroke-width": "12" }],
      ...blush("#ffc9b8"),
    ],
  },
  ninja: {
    label: "Ninja",
    face: "#2d323d",
    eye: "#2a211b",
    back: [
      ["rect", { x: "0", y: "56", width: "256", height: "26", fill: "#e5484d" }],
      ["path", { d: "M222 70l30-30M222 70l32 8", stroke: "#e5484d", "stroke-width": "12", "stroke-linecap": "round" }],
      ["rect", { x: "26", y: "108", width: "204", height: "80", rx: "40", fill: "#f2cfae" }],
    ],
    eyeScale: 0.85,
  },
};
