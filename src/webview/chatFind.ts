/**
 * Find in the chat (Ctrl+F, Cmd+F on macOS): a small bar at the top right, like the find widget of the editor.
 * Matches get a highlight without changing the text (the CSS Custom Highlight API), Enter and Shift+Enter
 * move between them, and a match inside a folded command or a closed group opens it. The terminals in the
 * chat keep their own Ctrl+F.
 */

interface ChatFind {
  open(): void;
  close(): void;
}

const maximumMatches = 1000;

/** Text that is not part of the conversation: buttons, times, and the canvas of live terminals. */
const skipped = ".xterm, .message-actions, time, .action, .term-actions, .term-fix, .copy, .find-bar, script, style";

export function createChatFind(transcript: HTMLElement, bar: HTMLElement): ChatFind {
  const input = bar.querySelector<HTMLInputElement>("input") as HTMLInputElement;
  const count = bar.querySelector<HTMLElement>(".find-count") as HTMLElement;
  const [previous, next, close] = [...bar.querySelectorAll<HTMLButtonElement>("button")];
  let matches: Range[] = [];
  let current = -1;
  const highlights = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
  const HighlightClass = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

  const paint = () => {
    if (!highlights || !HighlightClass) return;
    highlights.set("phew-find", new HighlightClass(...matches));
    const active = matches[current];
    if (active) highlights.set("phew-find-current", new HighlightClass(active));
    else highlights.delete("phew-find-current");
  };

  const search = () => {
    const query = input.value.toLowerCase();
    matches = [];
    current = -1;
    if (query) {
      const walker = document.createTreeWalker(transcript, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          node.parentElement?.closest(skipped) || !node.nodeValue?.trim()
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
      });
      for (let node = walker.nextNode(); node && matches.length < maximumMatches; node = walker.nextNode()) {
        const text = (node.nodeValue ?? "").toLowerCase();
        for (
          let at = text.indexOf(query);
          at >= 0 && matches.length < maximumMatches;
          at = text.indexOf(query, at + query.length)
        ) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + query.length);
          matches.push(range);
        }
      }
    }
    // Start at the match nearest to the end of the chat, where the reader most likely is.
    if (matches.length > 0) current = matches.length - 1;
    show();
  };

  const show = () => {
    count.textContent = input.value
      ? matches.length === 0
        ? "No results"
        : `${current + 1} of ${matches.length}${matches.length >= maximumMatches ? "+" : ""}`
      : "";
    bar.classList.toggle("missing", Boolean(input.value) && matches.length === 0);
    const active = matches[current];
    if (active) {
      const holder = active.startContainer.parentElement;
      // A match inside a folded command or a closed group opens it.
      const term = holder?.closest(".term.collapsed");
      if (term) term.classList.remove("collapsed");
      for (let details = holder?.closest("details"); details; details = details.parentElement?.closest("details"))
        details.open = true;
      holder?.scrollIntoView({ block: "center" });
    }
    paint();
  };

  const move = (step: number) => {
    // The chat changes while a task runs: a match that left the page means searching again.
    if (matches.some((range) => !range.startContainer.isConnected)) search();
    if (matches.length === 0) return;
    current = (current + step + matches.length) % matches.length;
    show();
  };

  const api: ChatFind = {
    open() {
      bar.hidden = false;
      const selected = window.getSelection()?.toString().trim();
      if (selected && !selected.includes("\n") && selected.length <= 100) input.value = selected;
      input.focus();
      input.select();
      search();
    },
    close() {
      bar.hidden = true;
      matches = [];
      current = -1;
      highlights?.delete("phew-find");
      highlights?.delete("phew-find-current");
    },
  };

  input.addEventListener("input", search);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === "F3") {
      event.preventDefault();
      move(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      api.close();
    }
  });
  previous?.addEventListener("click", () => move(-1));
  next?.addEventListener("click", () => move(1));
  close?.addEventListener("click", () => api.close());
  document.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement | null;
    // The terminals of commands have their own find.
    if (target?.closest(".xterm")) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      api.open();
    } else if (event.key === "F3" && !bar.hidden) {
      event.preventDefault();
      move(event.shiftKey ? -1 : 1);
    }
  });
  return api;
}
