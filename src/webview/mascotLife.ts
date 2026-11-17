import {
  gazeOffset,
  longTaskMs,
  type MascotAct,
  type MascotMood,
  type MascotMotion,
  mascotPose,
  nextBlink,
  sleepAfterMs,
} from "../core/mascotLife";
import { toolCategory } from "./toolLabels";

/**
 * Brings the live mascots to life: blinks, a gaze that shows what the agent does, and rest when nothing happens.
 * Only CSS attributes change here; the drawings stay static SVG.
 */

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let mood: MascotMood = "idle";
let act: MascotAct | undefined;
let motion: MascotMotion = "lively";
let typing = false;
let asleep = false;
let pointer: { x: number; y: number } | undefined;
let lastActivity = Date.now();
let workStart = 0;
let blinks = false;
let blinkTimer: ReturnType<typeof setTimeout> | undefined;
let typingTimer: ReturnType<typeof setTimeout> | undefined;
let longTimer: ReturnType<typeof setTimeout> | undefined;
let frame = 0;

function liveMascots(): NodeListOf<SVGSVGElement> {
  return document.querySelectorAll<SVGSVGElement>("svg.live-mascot");
}

function currentMotion(): MascotMotion {
  return reducedMotion.matches ? "still" : motion;
}

/** How much mascots may move now: the setting, or "still" when the system asks for reduced motion. */
export function mascotMotion(): MascotMotion {
  return currentMotion();
}

function setData(node: SVGSVGElement, key: string, value: string): void {
  if (node.dataset[key] !== value) node.dataset[key] = value;
}

/** Applies the pose to every live mascot. */
export function renderMascots(): void {
  const pose = mascotPose({
    mood,
    act,
    motion: currentMotion(),
    typing,
    asleep,
    pointer: pointer !== undefined,
    longTask: mood === "working" && workStart > 0 && Date.now() - workStart >= longTaskMs,
  });
  for (const node of liveMascots()) {
    setData(node, "face", pose.face);
    setData(node, "look", pose.look);
    node.classList.toggle("sweat", pose.sweat);
    if (pose.look === "follow" && pointer) {
      const box = node.getBoundingClientRect();
      if (box.width === 0) continue;
      // The offset is in the units of the drawing, so small and large mascots look the same way.
      const scale = 256 / box.width;
      const offset = gazeOffset(
        (pointer.x - (box.left + box.width / 2)) * Math.min(scale, 3),
        (pointer.y - (box.top + box.height / 2)) * Math.min(scale, 3),
      );
      node.style.setProperty("--gaze-x", `${offset.x}px`);
      node.style.setProperty("--gaze-y", `${offset.y}px`);
    } else if (node.style.length > 0) {
      node.style.removeProperty("--gaze-x");
      node.style.removeProperty("--gaze-y");
    }
  }
  const canBlink = pose.blinks && currentMotion() !== "still" && !document.hidden;
  if (canBlink !== blinks) {
    blinks = canBlink;
    scheduleBlink();
  }
}

function scheduleRender(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    renderMascots();
  });
}

function blinkOnce(): void {
  const nodes = [...liveMascots()];
  for (const node of nodes) node.classList.add("blink");
  setTimeout(() => {
    for (const node of nodes) node.classList.remove("blink");
  }, 130);
}

function scheduleBlink(): void {
  if (blinkTimer) clearTimeout(blinkTimer);
  blinkTimer = undefined;
  if (!blinks) return;
  const next = nextBlink();
  blinkTimer = setTimeout(() => {
    if (!blinks) return;
    blinkOnce();
    if (next.double) setTimeout(blinkOnce, 260);
    scheduleBlink();
  }, next.delay);
}

function wake(): void {
  lastActivity = Date.now();
  if (!asleep) return;
  asleep = false;
  renderMascots();
  if (blinks) setTimeout(blinkOnce, 120);
}

/** The mood follows the task: idle, working, done, or failed. */
export function setMascotMood(next: MascotMood): void {
  if (next === mood) return;
  mood = next;
  if (longTimer) clearTimeout(longTimer);
  longTimer = undefined;
  if (next === "working") {
    workStart = Date.now();
    longTimer = setTimeout(renderMascots, longTaskMs + 50);
  } else {
    workStart = 0;
    act = undefined;
  }
  wake();
  renderMascots();
}

/** What the agent does now. */
export function setMascotAct(next: MascotAct | undefined): void {
  if (next === act) return;
  act = next;
  renderMascots();
}

/** The act for a running tool: reading and searching scan, edits focus, commands look down at the terminal. */
export function actForTool(name: string): MascotAct {
  if (name === "ask_user") return "wait";
  const category = toolCategory(name);
  if (category === "read" || category === "search") return "read";
  if (category === "edit") return "edit";
  if (category === "run" || category === "check") return "run";
  return "think";
}

export function setMascotMotion(next: MascotMotion): void {
  if (next === motion) return;
  motion = next;
  renderMascots();
}

/** The eyes look down at the input box while the user types, then return. */
export function mascotSeesTyping(): void {
  wake();
  typing = true;
  if (typingTimer) clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    typing = false;
    renderMascots();
  }, 1400);
  renderMascots();
}

/** Starts the listeners once. */
export function startMascotLife(): void {
  document.addEventListener(
    "pointermove",
    (event) => {
      wake();
      if (currentMotion() !== "lively" || mood !== "idle") {
        pointer = undefined;
        return;
      }
      pointer = { x: event.clientX, y: event.clientY };
      scheduleRender();
    },
    { passive: true },
  );
  document.documentElement.addEventListener("pointerleave", () => {
    pointer = undefined;
    scheduleRender();
  });
  document.addEventListener("keydown", wake, { passive: true });
  document.addEventListener("visibilitychange", () => {
    document.body.classList.toggle("mascot-paused", document.hidden);
    if (!document.hidden) wake();
    renderMascots();
  });
  reducedMotion.addEventListener("change", renderMascots);
  setInterval(() => {
    if (!asleep && mood === "idle" && !document.hidden && Date.now() - lastActivity >= sleepAfterMs) {
      asleep = true;
      renderMascots();
    }
  }, 20_000);
  renderMascots();
}
