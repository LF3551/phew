import * as path from "node:path";
import { resolveInside, toRelative } from "./paths";

export interface Root {
  readonly name: string;
  readonly path: string;
}

/**
 * The folders of a session. With one folder, paths are relative to it. With several folders, paths start
 * with the folder name, like `api/src/app.ts`, the same way as VS Code shows them.
 */
export class RootSet {
  readonly roots: readonly Root[];

  constructor(roots: readonly Root[]) {
    if (roots.length === 0) throw new Error("A session needs at least one folder.");
    const seen = new Map<string, number>();
    this.roots = roots.map((root) => {
      const count = (seen.get(root.name) ?? 0) + 1;
      seen.set(root.name, count);
      return { name: count > 1 ? `${root.name}-${count}` : root.name, path: root.path };
    });
  }

  get primary(): Root {
    return this.roots[0];
  }

  get multi(): boolean {
    return this.roots.length > 1;
  }

  /** The root that contains an absolute path, if any. */
  rootOf(absolute: string): Root | undefined {
    return [...this.roots]
      .sort((a, b) => b.path.length - a.path.length)
      .find((root) => resolveInside(root.path, absolute) === path.resolve(absolute));
  }

  /** Resolves a path from the model. Returns undefined when it is outside every root. */
  resolve(input: string): string | undefined {
    const cleaned = input.trim().replace(/^["']|["']$/g, "");
    if (path.isAbsolute(cleaned)) {
      const root = this.rootOf(cleaned);
      return root ? path.resolve(cleaned) : undefined;
    }
    if (this.multi) {
      const [first, ...rest] = cleaned.split(/[/\\]/);
      const root = this.roots.find((item) => item.name === first);
      if (root) return resolveInside(root.path, rest.join("/") || ".");
    }
    return resolveInside(this.primary.path, cleaned);
  }

  /** The display path of an absolute path: relative, with the folder name when there are several folders. */
  display(absolute: string): string {
    const root = this.rootOf(absolute) ?? this.primary;
    const relative = toRelative(root.path, absolute);
    return this.multi ? `${root.name}/${relative}` : relative;
  }

  describe(): string {
    if (!this.multi) return `Workspace folder: ${this.primary.name}.`;
    return [
      "The workspace has several folders. Paths start with the folder name:",
      ...this.roots.map((root, index) => `- ${root.name}/${index === 0 ? " (commands run here by default)" : ""}`),
    ].join("\n");
  }
}
