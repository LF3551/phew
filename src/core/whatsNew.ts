/**
 * "New in Phew": a short card after an update to a new minor version, so changes never come as a surprise.
 * A fresh install shows nothing. Each minor version lists what a user notices, not every detail.
 */

const notes: Readonly<Record<string, readonly string[]>> = {
  "0.5": [
    "A start card shows the models that are ready on this computer and free ways to begin.",
    "A calmer chat: short commands fold into one line, and long output shows its end.",
    "Retry when the model goes quiet. Long chats open about 15 times faster.",
    "Keys from a command, for Vertex AI, Azure with Entra ID, and company sign-in.",
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
