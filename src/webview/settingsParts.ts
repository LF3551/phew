import { icon } from "../shared/icons";

/** Shared parts of the settings page: the menu groups, the icons, and the section titles. */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The groups of the menu, in order. */
export const groupOrder = ["Models", "Agent", "Safety", "Git and tools", "Look and feel"];

/** The group, the icon, and a short line for each section. */
export function sectionInfo(title: string): { group: string; icon: string; line?: string } {
  const info: Record<string, { group: string; icon: string; line?: string }> = {
    Models: { group: "Models", icon: "sparkle", line: "The models that Phew can use, and how to connect more." },
    "Model Connection": {
      group: "Models",
      icon: "split",
      line: "Timeouts, retries, and how Phew talks to the provider.",
    },
    Autocomplete: { group: "Models", icon: "type", line: "Inline completions and the next edit." },
    "Code Index": { group: "Models", icon: "search", line: "Finds relevant code by meaning." },
    Agent: { group: "Agent", icon: "code", line: "How the agent works, notifies you, and sends messages." },
    Assistant: { group: "Agent", icon: "ask", line: "Its name, look, character, and language." },
    "Memory, Modes, and Skills": {
      group: "Agent",
      icon: "book",
      line: "What the agent remembers, its modes, and its skills.",
    },
    Handoff: { group: "Agent", icon: "export", line: "Notes that let any agent continue the work." },
    Approvals: { group: "Safety", icon: "shield", line: "What runs without asking: edits, commands, and MCP tools." },
    Checks: { group: "Safety", icon: "check", line: "The command that proves a fix, for example npm test." },
    Budget: { group: "Safety", icon: "balance", line: "Limits for tokens and cost." },
    Privacy: { group: "Safety", icon: "lock", line: "Files and secrets that never reach the model." },
    Commits: { group: "Git and tools", icon: "git", line: "Messages, author, signing, and trailers." },
    Worktrees: { group: "Git and tools", icon: "pin", line: "Agents that work on a branch in another folder." },
    MCP: { group: "Git and tools", icon: "queue", line: "Tools from MCP servers." },
    Appearance: { group: "Look and feel", icon: "image", line: "Style, colors, and the mascot." },
    Interface: { group: "Look and feel", icon: "edit", line: "Fonts, sizes, and details of the chat." },
    Statistics: { group: "Look and feel", icon: "history", line: "Bugs fixed and time saved, on this computer only." },
  };
  return info[title] ?? { group: "More", icon: "more" };
}

/** A section title with its icon and a short line about it. */
export function sectionHeader(title: string): HTMLElement {
  const info = sectionInfo(title);
  const header = el("div", "section-header");
  const glyph = el("span", "section-icon");
  glyph.append(iconNode(info.icon));
  const text = el("div", "section-text");
  text.append(el("h2", undefined, title));
  if (info.line) text.append(el("p", "section-line", info.line));
  header.append(glyph, text);
  return header;
}

export function iconNode(name: string): Element {
  const template = document.createElement("template");
  template.innerHTML = icon(name);
  return template.content.firstElementChild as Element;
}
