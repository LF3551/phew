/**
 * "New in Phew": a short card after an update to a new minor version, so changes never come as a surprise.
 * A fresh install shows nothing. Each minor version lists what a user notices, not every detail.
 */

const notes: Readonly<Record<string, readonly string[]>> = {
  "1.1": [
    "Each chat keeps its own model, so two chats or two windows can work with different models or keys at once.",
    "The list of chats shows which agent needs you, which one failed or went quiet, and which one is done.",
    "A model can have a fallback: when its quota or credit runs out, the fallback goes on with the task. Set it in Settings → Models → ⋯.",
  ],
  "1.0": [
    "Phew 1.0 is out of preview. Thank you for trying it early.",
    "Each chat starts with an overview of the project: the stack, the commands, and the layout. /init writes AGENTS.md.",
    "Rules come with the files they are for, from AGENTS.md in subfolders and the rules of Copilot, Claude, Cursor, and others.",
    "Memory keeps the file of each fact and asks for a check when it changed. Personal preferences apply in every project.",
    "Type @ to bring an earlier chat into this one. /learn saves what a chat taught.",
  ],
  "0.5": [
    "The files to review sit above the input, with Keep and Undo for each file.",
    "Find in the chat with Ctrl+F, search all chats by their messages, and fork any message.",
    "A calmer chat: short commands fold into one line, long output shows its end, and long pastes become a chip.",
    "Retry when the model goes quiet. Long chats open about 15 times faster.",
    "A start card shows the models ready on this computer and free ways to begin.",
  ],
};

export interface WhatsNew {
  /** The minor version, for example "0.5". */
  readonly version: string;
  readonly items: readonly string[];
}

/** "0.5.3" → "0.5". */
export function minorVersion(version: string): string {
  return version.split(".").slice(0, 2).join(".");
}

/** What to show after an update from `seen` to `current`; nothing after a fresh install or a patch. */
export function whatsNewFor(current: string, seen: string | undefined): WhatsNew | undefined {
  if (!seen) return undefined;
  const minor = minorVersion(current);
  if (minor === minorVersion(seen)) return undefined;
  const items = notes[minor];
  return items ? { version: minor, items } : undefined;
}
