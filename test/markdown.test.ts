// @vitest-environment jsdom
import { expect, test } from "vitest";
import { renderMarkdown } from "../src/webview/markdown";

function html(text: string): string {
  const container = document.createElement("div");
  container.append(renderMarkdown(text));
  return container.innerHTML;
}

test("renders code blocks, lists, headings, and inline styles", () => {
  expect(html("# Title\n\n- **bold** and `code`\n- *em*\n\n```ts\nconst a = 1;\n```")).toBe(
    '<h3>Title</h3><ul><li><strong>bold</strong> and <code>code</code></li><li><em>em</em></li></ul><pre><code data-language="ts">const a = 1;</code></pre>',
  );
});

test("never creates HTML from the model output", () => {
  const output = html('<img src=x onerror="alert(1)"> [link](javascript:alert(1))\n```\n<script>x</script>\n```');
  expect(output).not.toContain("<img");
  expect(output).not.toContain("<script>");
  expect(output).toContain("&lt;img");
  expect(output).not.toContain('href="javascript');
});
