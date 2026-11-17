/**
 * The behavior of the living mascot: which face it shows and where it looks.
 * The rules keep it calm. It moves only to show what the agent does, and it rests when nothing happens.
 */

export type MascotMood = "idle" | "working" | "done" | "failed";

/** What the agent does now, from the stream of events. */
export type MascotAct = "think" | "write" | "read" | "edit" | "run" | "wait";

/** How much the mascot moves: everything, only blinks and faces, or nothing. */
export type MascotMotion = "lively" | "calm" | "still";

export type MascotFace = "open" | "relief" | "focus" | "worry" | "sleepy";

/** Where the eyes look. "follow" uses the pointer position. */
export type MascotLook = "center" | "up" | "down" | "scan" | "follow";

export interface MascotInput {
  readonly mood: MascotMood;
  readonly act?: MascotAct;
  readonly motion: MascotMotion;
  /** The user types in the input box. */
  readonly typing?: boolean;
  /** Nothing happened for a long time. */
  readonly asleep?: boolean;
  /** The pointer is in the view, so the eyes can follow it. */
  readonly pointer?: boolean;
  /** The task runs for a long time. */
  readonly longTask?: boolean;
}

export interface MascotPose {
  readonly face: MascotFace;
  readonly look: MascotLook;
  /** Whether the eyes can blink in this pose. */
  readonly blinks: boolean;
  /** A drop of sweat runs down: the agent waits for the user or works hard. */
  readonly sweat: boolean;
}

const stillFaces: Record<MascotMood, MascotFace> = {
  idle: "relief",
  working: "focus",
  done: "relief",
  failed: "worry",
};

const actLooks: Record<MascotAct, MascotLook> = {
  think: "up",
  write: "scan",
  read: "scan",
  edit: "center",
  run: "down",
  wait: "up",
};

export function mascotPose(input: MascotInput): MascotPose {
  if (input.motion === "still") {
    return { face: stillFaces[input.mood], look: "center", blinks: false, sweat: input.mood === "working" };
  }
  const lively = input.motion === "lively";
  if (input.mood === "failed") return { face: "worry", look: "center", blinks: false, sweat: false };
  if (input.mood === "done") return { face: "relief", look: "center", blinks: false, sweat: false };
  if (input.mood === "working") {
    const act = input.act ?? "think";
    const face: MascotFace = act === "edit" ? "focus" : "open";
    return {
      face,
      look: lively ? actLooks[act] : "center",
      blinks: face === "open",
      sweat: act === "wait" || input.longTask === true,
    };
  }
  if (input.asleep && lively) return { face: "sleepy", look: "center", blinks: false, sweat: false };
  const look: MascotLook = !lively ? "center" : input.typing ? "down" : input.pointer ? "follow" : "center";
  return { face: "open", look, blinks: true, sweat: false };
}

/**
 * The time until the next blink. People blink every few seconds at irregular times,
 * and sometimes twice. A fixed rhythm looks mechanical.
 */
export function nextBlink(random: () => number = Math.random): { readonly delay: number; readonly double: boolean } {
  return { delay: Math.round(2800 + random() * 4400), double: random() < 0.18 };
}

/**
 * The offset of the eyes toward a point, in the units of the mascot drawing.
 * Far points give the full offset; points near the face give a smaller one.
 */
export function gazeOffset(dx: number, dy: number, max = 18, reach = 240): { readonly x: number; readonly y: number } {
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance < 1) return { x: 0, y: 0 };
  const strength = Math.min(1, distance / reach) * max;
  const round = (value: number) => Math.round(value * 10) / 10;
  return { x: round((dx / distance) * strength), y: round((dy / distance) * strength * 0.7) };
}

/** Minutes without any activity before the mascot falls asleep. */
export const sleepAfterMs = 4 * 60_000;

/** Seconds of work after which the mascot starts to sweat. */
export const longTaskMs = 45_000;
