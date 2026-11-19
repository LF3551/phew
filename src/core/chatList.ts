import type { ChatMessage } from "./chat";

const previewLength = 120;

function oneLine(text: string): string {
  return text
    .replace(/\[\d+ image\(s\) were attached\]/g, "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/[`*_#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text: string): string {
  return text.length > previewLength ? `${text.slice(0, previewLength - 1).trimEnd()}…` : text;
}

/**
 * A short line that tells chats apart in the chat list.
 * Uses the last request of the user, or the last answer when the request repeats the title.
 */
export function chatPreview(history: readonly ChatMessage[], title: string): string | undefined {
  const normalizedTitle = oneLine(title).toLowerCase();
  const fresh = (text: string) => text !== "" && text.toLowerCase() !== normalizedTitle;
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message?.role !== "user") continue;
    const text = oneLine(message.content);
    if (fresh(text)) return clip(text);
    break;
  }
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message?.role !== "assistant") continue;
    const text = oneLine(message.content);
    if (fresh(text)) return clip(text);
  }
  return undefined;
}

export type ChatGroup = "today" | "yesterday" | "week" | "earlier";

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** The date group of a chat in the list, by the local calendar day. */
export function chatGroup(at: number, now = Date.now()): ChatGroup {
  const today = startOfDay(now);
  if (at >= today) return "today";
  const yesterday = startOfDay(today - 1);
  if (at >= yesterday) return "yesterday";
  if (at >= startOfDay(today - 6 * 86_400_000)) return "week";
  return "earlier";
}

export const chatGroupLabels: Record<ChatGroup, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "Previous 7 days",
  earlier: "Earlier",
};

/** A compact time for a chat row: "now", "5m", "4h", a clock time yesterday, a weekday, or a date. */
export function chatTime(at: number, now = Date.now(), locale?: string): string {
  if (!Number.isFinite(at)) return "";
  const minutes = Math.floor((now - at) / 60_000);
  const group = chatGroup(at, now);
  if (group === "today") {
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h`;
  }
  const date = new Date(at);
  if (group === "yesterday") return date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (group === "week") return date.toLocaleDateString(locale, { weekday: "short" });
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(locale, sameYear ? { month: "short", day: "numeric" } : { dateStyle: "medium" });
}

/** True when every word of the query appears in the title or the preview. */
export function matchesChat(query: string, title: string, preview = ""): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${title}\n${preview}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/**
 * A short piece of a chat around the first place where all words of the query meet, for full-text search
 * in the history: "…the timeout was read from the wrong option…". Undefined when the chat does not match.
 */
export function contentSnippet(query: string, texts: readonly string[], width = 90): string | undefined {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  const all = texts.join("\n").toLowerCase();
  if (!words.every((word) => all.includes(word))) return undefined;
  // The text where the longest word appears first, so the snippet shows the most telling match.
  const key = [...words].sort((a, b) => b.length - a.length)[0] ?? "";
  for (const text of texts) {
    const at = text.toLowerCase().indexOf(key);
    if (at < 0) continue;
    const flat = text.replace(/\s+/g, " ");
    const position = flat.toLowerCase().indexOf(key);
    const start = Math.max(0, position - Math.floor((width - key.length) / 2));
    const end = Math.min(flat.length, start + width);
    return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
  }
  return undefined;
}

/** Splits text into plain and matched parts, so the view can highlight matches without HTML. */
export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (words.length === 0) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const parts: { text: string; match: boolean }[] = [];
  let index = 0;
  let plainStart = 0;
  while (index < text.length) {
    const word = words.find((candidate) => lower.startsWith(candidate, index));
    if (!word) {
      index++;
      continue;
    }
    if (index > plainStart) parts.push({ text: text.slice(plainStart, index), match: false });
    parts.push({ text: text.slice(index, index + word.length), match: true });
    index += word.length;
    plainStart = index;
  }
  if (plainStart < text.length) parts.push({ text: text.slice(plainStart), match: false });
  return parts;
}
