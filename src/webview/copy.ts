import { icon } from "../shared/icons";
import type { WebviewMessage } from "../shared/protocol";

/**
 * One way to copy everywhere in the chat, with clear feedback:
 * the icon turns into a green check, a small "Copied" bubble appears over the button,
 * and screen readers hear it. When the webview cannot write to the clipboard, the extension writes instead.
 */

let post: ((message: WebviewMessage) => void) | undefined;
let liveRegion: HTMLElement | undefined;
let bubble: HTMLElement | undefined;
let bubbleTimer: ReturnType<typeof setTimeout> | undefined;
const resetTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

export function setCopyFallback(send: (message: WebviewMessage) => void): void {
  post = send;
}

function announce(text: string): void {
  if (!liveRegion) {
    liveRegion = document.createElement("div");
    liveRegion.className = "visually-hidden";
    liveRegion.setAttribute("role", "status");
    liveRegion.setAttribute("aria-live", "polite");
    document.body.append(liveRegion);
  }
  // Clear first, so the same message is announced again.
  liveRegion.textContent = "";
  const region = liveRegion;
  setTimeout(() => {
    region.textContent = text;
  }, 30);
}

function showBubble(anchor: HTMLElement, text: string, failed: boolean): void {
  if (!bubble) {
    bubble = document.createElement("div");
    bubble.className = "copy-bubble";
    bubble.setAttribute("aria-hidden", "true");
    document.body.append(bubble);
  }
  const node = bubble;
  node.textContent = text;
  node.classList.toggle("failed", failed);
  node.classList.remove("visible");
  const box = anchor.getBoundingClientRect();
  node.style.left = `${Math.round(box.left + box.width / 2)}px`;
  node.style.top = `${Math.round(box.top)}px`;
  // Below the button when there is no room above.
  node.classList.toggle("below", box.top < 34);
  if (box.top < 34) node.style.top = `${Math.round(box.bottom)}px`;
  void node.getBoundingClientRect();
  node.classList.add("visible");
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => node.classList.remove("visible"), 1400);
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!post) return false;
    post({ type: "copyText", text });
    return true;
  }
}

/** Shows the result on the button: a check (or a cross) instead of the icon, and the label for text buttons. */
function mark(button: HTMLElement, state: "copied" | "failed", copiedLabel: string): void {
  const previous = resetTimers.get(button);
  if (previous) clearTimeout(previous);
  if (button.dataset.copyOriginal === undefined) {
    button.dataset.copyOriginal = button.innerHTML;
    button.dataset.copyTitle = button.title;
  }
  const original = button.dataset.copyOriginal;
  const title = button.dataset.copyTitle ?? "";
  const label = button.querySelector(".copy-label");
  const glyph = icon(state === "copied" ? "check" : "close");
  if (button.querySelector("svg")) {
    button.innerHTML = label
      ? `${glyph}<span class="copy-label">${state === "copied" ? copiedLabel : "Failed"}</span>`
      : glyph;
  } else {
    button.textContent = state === "copied" ? copiedLabel : "Couldn't copy";
  }
  button.dataset.copyState = state;
  button.title = state === "copied" ? copiedLabel : "Couldn't copy";
  button.classList.remove("copy-pop");
  void button.getBoundingClientRect();
  button.classList.add("copy-pop");
  resetTimers.set(
    button,
    setTimeout(() => {
      button.innerHTML = original;
      button.title = title;
      delete button.dataset.copyState;
      delete button.dataset.copyOriginal;
      delete button.dataset.copyTitle;
      button.classList.remove("copy-pop");
    }, 1600),
  );
}

/** Copies the text and shows the result on the button. `what` names the content, for example "Code". */
export async function copyWithFeedback(button: HTMLElement, text: string, what = "Text"): Promise<void> {
  const ok = text.length > 0 && (await writeClipboard(text));
  const message = ok ? `${what} copied` : "Couldn't copy";
  // Buttons with a label say it themselves; icon buttons get a bubble.
  const iconOnly = !button.querySelector(".copy-label") && button.querySelector("svg") !== null;
  mark(button, ok ? "copied" : "failed", "Copied");
  if (iconOnly) showBubble(button, ok ? "Copied" : "Couldn't copy", !ok);
  announce(message);
}
