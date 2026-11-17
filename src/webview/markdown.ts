/** Renders a safe subset of Markdown into DOM nodes. It never parses HTML. */
export function renderMarkdown(text: string, doc: Document = document): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  let paragraph: string[] = [];
  let list: HTMLElement | undefined;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const element = doc.createElement("p");
    appendInline(element, paragraph.join("\n"), doc);
    fragment.append(element);
    paragraph = [];
  };
  const closeList = () => {
    list = undefined;
  };

  while (index < lines.length) {
    const line = lines[index];
    const fence = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      closeList();
      const body: string[] = [];
      index++;
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) body.push(lines[index++]);
      index++;
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      if (fence[2]) code.dataset.language = fence[2];
      code.textContent = body.join("\n");
      pre.append(code);
      fragment.append(pre);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const element = doc.createElement(`h${Math.min(heading[1].length + 2, 6)}`);
      appendInline(element, heading[2], doc);
      fragment.append(element);
      index++;
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      const ordered = /\d/.test(item[1]);
      const tag = ordered ? "OL" : "UL";
      if (!list || list.tagName !== tag) {
        list = doc.createElement(ordered ? "ol" : "ul");
        fragment.append(list);
      }
      const element = doc.createElement("li");
      appendInline(element, item[2], doc);
      list.append(element);
      index++;
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      closeList();
      index++;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      closeList();
      const quote = doc.createElement("blockquote");
      appendInline(quote, line.replace(/^\s*>\s?/, ""), doc);
      fragment.append(quote);
      index++;
      continue;
    }
    closeList();
    paragraph.push(line);
    index++;
  }
  flushParagraph();
  return fragment;
}

/** Adds inline code, bold, and italic text. Links are shown as plain text for safety. */
function appendInline(parent: HTMLElement, text: string, doc: Document): void {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) appendText(parent, text.slice(last, start), doc);
    const token = match[0];
    let element: HTMLElement;
    if (token.startsWith("`")) {
      element = doc.createElement("code");
      element.textContent = token.slice(1, -1);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      element = doc.createElement("strong");
      element.textContent = token.slice(2, -2);
    } else {
      element = doc.createElement("em");
      element.textContent = token.slice(1, -1);
    }
    parent.append(element);
    last = start + token.length;
  }
  if (last < text.length) appendText(parent, text.slice(last), doc);
}

function appendText(parent: HTMLElement, text: string, doc: Document): void {
  const parts = text.split("\n");
  parts.forEach((part, index) => {
    if (index > 0) parent.append(doc.createElement("br"));
    parent.append(doc.createTextNode(part));
  });
}
