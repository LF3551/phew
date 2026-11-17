/** What the Phew icon in the activity bar shows when the user does not look at the chat. */

export interface ActivityCounts {
  /** Chats that wait for an answer or an approval. */
  readonly waiting: number;
  /** Chats that finished while the chat view was hidden. */
  readonly unseen: number;
}

export interface ActivityBadge {
  readonly value: number;
  readonly tooltip: string;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * A waiting chat matters most, so it wins over finished chats.
 * Running chats need no badge: the view shows the progress of VS Code instead.
 */
export function activityBadge(counts: ActivityCounts, name = "Phew"): ActivityBadge | undefined {
  if (counts.waiting > 0) {
    return {
      value: counts.waiting,
      tooltip: `${name} needs your answer in ${plural(counts.waiting, "chat", "chats")}`,
    };
  }
  if (counts.unseen > 0) {
    return { value: counts.unseen, tooltip: `${name} finished ${plural(counts.unseen, "chat", "chats")}` };
  }
  return undefined;
}
