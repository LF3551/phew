import {
  type ApprovalLevel,
  type ApprovalValues,
  approvalDifferences,
  approvalLevel,
  approvalLevelInfo,
  approvalLevels,
  approvalPresets,
  commandInfo,
  mcpInfo,
  reviewInfo,
} from "../core/approvals";
import { icon } from "../shared/icons";
import type { ViewState, WebviewMessage } from "../shared/protocol";

/**
 * Auto-approve for this chat: three levels in one click, then the three rows as segments
 * with one sentence each about what really happens. The shield in the input shows the level.
 */

type Approvals = ViewState["approvals"];

const levelIcons: Readonly<Record<ApprovalLevel, string>> = {
  careful: "shield",
  balanced: "balance",
  autopilot: "bolt",
};

function iconNode(name: string): Element {
  const template = document.createElement("template");
  template.innerHTML = icon(name);
  return template.content.firstElementChild as Element;
}

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

export interface ApprovalsPanel {
  update(approvals: Approvals, readOnlyMode: string | undefined): void;
}

export function createApprovalsPanel(options: {
  readonly button: HTMLButtonElement;
  readonly panel: HTMLElement;
  readonly dot: HTMLElement;
  readonly post: (message: WebviewMessage) => void;
}): ApprovalsPanel {
  const { button, panel, dot, post } = options;
  let state: Approvals | undefined;
  let readOnly: string | undefined;
  let key = "";

  const values = (): ApprovalValues | undefined =>
    state ? { review: state.review, commands: state.commands, mcp: state.mcp } : undefined;

  /** Shows the change at once; the host confirms it with the next state. */
  const apply = (next: Partial<ApprovalValues>) => {
    if (!state) return;
    state = { ...state, ...next };
    render();
  };

  const segments = <T extends string>(
    label: string,
    choices: readonly (readonly [T, string])[],
    current: T,
    onPick: (value: T) => void,
  ) => {
    const group = el("div", "segments");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", label);
    for (const [value, text] of choices) {
      const option = el("button", value === current ? "active" : undefined, text);
      option.type = "button";
      option.setAttribute("role", "radio");
      option.setAttribute("aria-checked", String(value === current));
      option.tabIndex = value === current ? 0 : -1;
      option.addEventListener("click", () => {
        if (value !== current) onPick(value);
      });
      group.append(option);
    }
    // Arrow keys move inside the group, like native radio buttons.
    group.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const index = choices.findIndex(([value]) => value === current);
      const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
      const next = choices[(index + step + choices.length) % choices.length];
      if (next) {
        onPick(next[0]);
        requestAnimationFrame(() =>
          panel.querySelector<HTMLButtonElement>(`[aria-label="${label}"] [aria-checked="true"]`)?.focus(),
        );
      }
    });
    return group;
  };

  const row = (label: string, control: HTMLElement, detail: Node | string) => {
    const wrap = el("div", "approval-row");
    const head = el("div", "approval-row-head");
    head.append(el("span", "approval-row-label", label), control);
    const note = el("div", "approval-detail");
    note.append(detail);
    wrap.append(head, note);
    return wrap;
  };

  const renderButton = () => {
    const current = values();
    if (!current || !state) return;
    const level = approvalLevel(current);
    const name = level === "custom" ? "custom" : level;
    button.replaceChildren(iconNode(level === "custom" ? "shield" : levelIcons[level]), dot);
    button.dataset.level = name;
    const label = level === "custom" ? "Custom" : approvalLevelInfo[level].label;
    button.title = `Auto-approve: ${label}${state.custom ? " (this chat only)" : ""}`;
    button.setAttribute("aria-label", button.title);
    dot.hidden = !state.custom;
  };

  const render = () => {
    const current = values();
    if (!current || !state) return;
    renderButton();
    const focusedLabel = (document.activeElement as HTMLElement | null)
      ?.closest("[role=radiogroup]")
      ?.getAttribute("aria-label");
    const level = approvalLevel(current);
    const children: Node[] = [];

    const title = el("div", "approvals-title");
    title.append(el("span", "popover-title", "Auto-approve"), el("span", "approvals-scope", "This chat"));
    children.push(title);

    if (readOnly)
      children.push(
        el(
          "p",
          "approvals-readonly",
          `${readOnly} mode changes nothing. These settings apply in modes that edit, such as Code and Debug.`,
        ),
      );

    // Levels
    const levels = el("div", "approval-levels");
    levels.setAttribute("role", "radiogroup");
    levels.setAttribute("aria-label", "Level");
    for (const item of approvalLevels) {
      const card = el("button", `approval-level level-${item}${item === level ? " active" : ""}`);
      card.type = "button";
      card.setAttribute("role", "radio");
      card.setAttribute("aria-checked", String(item === level));
      card.tabIndex = item === level || (level === "custom" && item === "balanced") ? 0 : -1;
      const glyph = el("span", "approval-level-icon");
      glyph.append(iconNode(levelIcons[item]));
      card.append(
        glyph,
        el("strong", undefined, approvalLevelInfo[item].label),
        el("span", undefined, approvalLevelInfo[item].hint),
      );
      card.addEventListener("click", () => {
        post({ type: "setApprovalLevel", level: item });
        apply(approvalPresets[item]);
      });
      levels.append(card);
    }
    levels.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const cards = [...levels.querySelectorAll<HTMLButtonElement>(".approval-level")];
      const index = cards.indexOf(document.activeElement as HTMLButtonElement);
      cards[(index + (event.key === "ArrowLeft" ? -1 : 1) + cards.length) % cards.length]?.focus();
    });
    children.push(levels);
    if (level === "custom")
      children.push(el("p", "approvals-custom", "Custom mix: the rows below differ from every level."));

    // Rows
    const rows = el("div", "approval-rows");
    rows.append(
      row(
        "Edits",
        segments(
          "Edits",
          (["chat", "editor", "none"] as const).map((value) => [value, reviewInfo[value].label] as const),
          current.review,
          (value) => {
            post({ type: "setApproval", key: "review", value });
            apply({ review: value });
          },
        ),
        reviewInfo[current.review].detail,
      ),
    );
    const commandDetail = el("span");
    commandDetail.append(commandInfo[current.commands].detail);
    if (current.commands === "allowlist") {
      const list = el("div", "allowlist");
      if (state.allowlist.length === 0)
        list.append(el("span", "allowlist-empty", "The allowlist is empty, so every command asks."));
      for (const prefix of state.allowlist.slice(0, 4)) list.append(el("code", "allowlist-chip", prefix));
      if (state.allowlist.length > 4) list.append(el("span", "allowlist-more", `+${state.allowlist.length - 4}`));
      const edit = el("button", "link", state.allowlist.length === 0 ? "Add commands…" : "Edit…");
      edit.type = "button";
      edit.addEventListener("click", () => post({ type: "editAllowlist" }));
      list.append(edit);
      commandDetail.append(list);
    }
    rows.append(
      row(
        "Commands",
        segments(
          "Commands",
          (["ask", "allowlist", "safe"] as const).map((value) => [value, commandInfo[value].label] as const),
          current.commands,
          (value) => {
            post({ type: "setApproval", key: "commands", value });
            apply({ commands: value });
          },
        ),
        commandDetail,
      ),
      row(
        "MCP tools",
        segments(
          "MCP tools",
          (["ask", "auto"] as const).map((value) => [value, mcpInfo[value].label] as const),
          current.mcp ? "auto" : "ask",
          (value) => {
            post({ type: "setApproval", key: "mcp", value: value === "auto" });
            apply({ mcp: value === "auto" });
          },
        ),
        mcpInfo[current.mcp ? "auto" : "ask"].detail,
      ),
    );
    if (readOnly) rows.classList.add("muted");
    children.push(rows);

    // Safety notes
    const notes = el("div", "approval-notes");
    const danger = el("p");
    danger.append(
      iconNode("warning"),
      el("span", undefined, "git push, rm -rf, sudo, terraform apply and other dangerous commands always ask."),
    );
    const undo = el("p");
    undo.append(iconNode("restore"), el("span", undefined, "Checkpoints let you undo any change of the agent."));
    notes.append(danger, undo);
    children.push(notes);

    // Save as default
    const differences = approvalDifferences(current, state.defaults);
    if (differences.length > 0) {
      const footer = el("div", "approval-footer");
      const list = el("div", "approval-differences");
      for (const line of differences) list.append(el("span", undefined, line));
      const save = el("button", "secondary", "Save as default");
      save.type = "button";
      save.title = "Use these settings for new chats too";
      save.addEventListener("click", () => post({ type: "resetApprovals" }));
      footer.append(list, save);
      children.push(footer);
    }

    panel.replaceChildren(...children);
    if (focusedLabel)
      panel.querySelector<HTMLButtonElement>(`[aria-label="${focusedLabel}"] [aria-checked="true"]`)?.focus();
  };

  return {
    update(next, nextReadOnly) {
      const nextKey = JSON.stringify([next, nextReadOnly]);
      if (nextKey === key) return;
      key = nextKey;
      state = next;
      readOnly = nextReadOnly;
      render();
    },
  };
}
