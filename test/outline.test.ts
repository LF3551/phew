import { describe, expect, test } from "vitest";
import { largeFileView, outlineOf } from "../src/core/outline";

const lines = (text: string) => text.split("\n");
const texts = (text: string) => outlineOf(lines(text)).map((entry) => `${entry.line} ${entry.text}`);

describe("outlineOf", () => {
  test("TypeScript: functions, classes, methods, types, and arrow functions", () => {
    expect(
      texts(
        [
          'import { a } from "./a";',
          "export interface Options {",
          "  readonly limit: number;",
          "}",
          "export type Mode = 'a' | 'b';",
          "export async function run(options: Options): Promise<void> {",
          "  if (options.limit > 2) {",
          "    for (const item of list) {",
          "    }",
          "  }",
          "}",
          "export class Store {",
          "  private readonly items = new Map();",
          "  async load(id: string): Promise<Item> {",
          "    return this.items.get(id);",
          "  }",
          "}",
          "export const parse = (text: string): number => Number(text);",
          "const handler = async (event) => {",
          "};",
        ].join("\n"),
      ),
    ).toEqual([
      "2 export interface Options",
      "5 export type Mode = 'a' | 'b';",
      "6 export async function run(options: Options): Promise<void>",
      "12 export class Store",
      "14 async load(id: string): Promise<Item>",
      "18 export const parse = (text: string): number => Number(text);",
      "19 const handler = async (event) =>",
    ]);
  });

  test("Python, Go, and Rust", () => {
    expect(
      texts("import os\n\nclass Repo:\n    def __init__(self):\n        pass\n\nasync def main():\n    x = 1"),
    ).toEqual(["3 class Repo:", "4 def __init__(self):", "7 async def main():"]);
    expect(
      texts("package main\n\ntype Server struct {\n}\n\nfunc (s *Server) Start() error {\n}\nfunc main() {"),
    ).toEqual(["3 type Server struct", "6 func (s *Server) Start() error", "8 func main()"]);
    expect(
      texts("pub struct Cache {\n}\nimpl Cache {\n    pub fn get(&self) -> u8 {\n    }\n}\nasync fn run() {"),
    ).toEqual(["1 pub struct Cache", "3 impl Cache", "4 pub fn get(&self) -> u8", "7 async fn run()"]);
  });

  test("Java, Kotlin, and Markdown", () => {
    expect(texts("public class Api {\n    public static void main(String[] args) {\n    }\n}")).toEqual([
      "1 public class Api",
      "2 public static void main(String[] args)",
    ]);
    expect(texts("class Repo {\n    suspend fun load(id: Int): Item {\n    }\n}")).toEqual([
      "1 class Repo",
      "2 suspend fun load(id: Int): Item",
    ]);
    expect(texts("# Title\n\ntext\n\n## Install\n\n#### Too deep")).toEqual(["1 # Title", "5 ## Install"]);
  });

  test("control flow and calls are not entries", () => {
    expect(texts("  if (ready) {\n  while (true) {\n  doThing();\n  return value;")).toEqual([]);
  });

  test("keeps at most the limit, and skips minified lines", () => {
    const many = Array.from({ length: 200 }, (_, index) => `function f${index}() {}`);
    expect(outlineOf(many)).toHaveLength(80);
    expect(outlineOf([`function x() {${"a".repeat(500)}}`])).toEqual([]);
  });
});

describe("largeFileView", () => {
  const file = Array.from({ length: 1000 }, (_, index) =>
    index % 100 === 0 ? `export function part${index}() {` : `  const value${index} = ${index};`,
  );

  test("gives the outline with line numbers and the first lines, not the whole file", () => {
    const view = largeFileView("src/big.ts", file);
    expect(view).toMatch(/^src\/big\.ts has 1000 lines, so here are its outline and its first 150 lines\./);
    expect(view).toMatch(/Outline:\n {3}1\| export function part0\(\)\n 101\| export function part100\(\)/);
    expect(view).toMatch(/ 901\| export function part900\(\)/);
    expect(view).toMatch(/Lines 1-150:\n {3}1\| export function part0\(\) \{/);
    expect(view).toMatch(/ 150\| {3}const value149 = 149;/);
    expect(view).not.toMatch(/value500/);
    expect(view.length).toBeLessThan(file.join("\n").length / 3);
  });

  test("says so when a file has no structure", () => {
    expect(
      largeFileView(
        "data.csv",
        Array.from({ length: 500 }, (_, index) => `${index},a,b`),
      ),
    ).toMatch(/\(no functions, classes, or headings found\)/);
  });
});
