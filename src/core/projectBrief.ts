/**
 * The project brief: a short overview that Phew gathers from the files of the workspace and gives the agent
 * at the start of every chat, so it knows the stack, the commands, and the layout without exploring first.
 * Only facts that the files show; the agent checks details in the files.
 */

export interface BriefInput {
  /** The entries at the top of the workspace. */
  readonly entries: readonly { readonly name: string; readonly directory: boolean }[];
  /** Small text files by name, as far as they exist: package.json, Makefile, pyproject.toml, README.md, and others. */
  readonly files: Readonly<Record<string, string>>;
  readonly branch?: string;
}

const folderPurposes: Readonly<Record<string, string>> = {
  src: "source code",
  source: "source code",
  lib: "library code",
  app: "application code",
  apps: "applications (monorepo)",
  packages: "packages (monorepo)",
  libs: "libraries (monorepo)",
  services: "services",
  cmd: "Go entry points",
  internal: "internal Go packages",
  pkg: "Go packages",
  api: "API",
  server: "server",
  backend: "backend",
  client: "client",
  frontend: "frontend",
  web: "web front end",
  ui: "user interface",
  components: "UI components",
  pages: "pages or routes",
  public: "static files",
  static: "static files",
  assets: "assets",
  test: "tests",
  tests: "tests",
  __tests__: "tests",
  spec: "tests",
  e2e: "end-to-end tests",
  docs: "documentation",
  doc: "documentation",
  scripts: "scripts",
  tools: "tools",
  bin: "executables",
  config: "configuration",
  migrations: "database migrations",
  db: "database",
  prisma: "Prisma schema",
  infra: "infrastructure",
  terraform: "Terraform",
  deploy: "deployment",
  deployments: "deployment",
  k8s: "Kubernetes manifests",
  charts: "Helm charts",
  helm: "Helm charts",
  docker: "Docker files",
  examples: "examples",
  media: "media",
  resources: "resources",
  site: "website",
  website: "website",
};

/** Build output, dependencies, and caches: never part of the overview. */
const ignoredFolders = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "vendor",
  "venv",
  ".venv",
  "__pycache__",
  "_site",
  ".next",
  ".nuxt",
]);

/** Scripts worth naming, in the order the agent needs them. */
const scriptOrder = ["check", "test", "lint", "typecheck", "build", "format", "dev", "start"];

function packageManager(names: ReadonlySet<string>): "pnpm" | "yarn" | "bun" | "npm" {
  if (names.has("pnpm-lock.yaml")) return "pnpm";
  if (names.has("yarn.lock")) return "yarn";
  if (names.has("bun.lockb") || names.has("bun.lock")) return "bun";
  return "npm";
}

function run(manager: string, script: string): string {
  if (manager === "npm") return script === "test" || script === "start" ? `npm ${script}` : `npm run ${script}`;
  return `${manager} ${script}`;
}

/** The first heading and the first sentence of the README, outside code blocks. */
function readmeSummary(text: string): string | undefined {
  // Code blocks hold shell comments that look like headings.
  const prose = text.replace(/^(```|~~~)[\s\S]*?^\1/gm, "");
  const lines = prose.split(/\r?\n/).map((line) => line.trim());
  const heading = lines.find((line) => /^#\s+\S/.test(line) || /^<h1\b/i.test(line));
  const title = heading
    ?.replace(/^#\s+/, "")
    .replace(/<[^>]+>/g, "")
    .trim();
  // The first paragraph of prose, with its wrapped lines joined.
  const start = lines.findIndex(
    (line) =>
      line && !/^(#|<|!\[|\[!|>|\||-{3,}|\*{3,}|[-*+] |\d+\. )/.test(line) && /[a-z]/i.test(line) && line.length > 20,
  );
  let paragraph = "";
  for (let index = start; index >= 0 && index < lines.length && lines[index]; index++) paragraph += ` ${lines[index]}`;
  const sentence = paragraph
    .replace(/<[^>]+>/g, "")
    .replace(/\*\*|__|`/g, "")
    .trim()
    .split(/(?<=[.!?])\s/)[0]
    ?.slice(0, 200);
  const parts = [title, sentence].filter(Boolean);
  return parts.length > 0 ? parts.join(": ") : undefined;
}

/** Make targets that a person would run: test, build, lint, and similar. */
function makeTargets(text: string): string[] {
  const targets = new Set<string>();
  for (const match of text.matchAll(/^([A-Za-z0-9][\w.-]*)\s*:(?!=)/gm)) targets.add(match[1] ?? "");
  const wanted = ["test", "check", "lint", "build", "fmt", "format", "run", "dev", "install"];
  return wanted.filter((name) => targets.has(name));
}

export function buildProjectBrief(input: BriefInput): string {
  const names = new Set(input.entries.map((entry) => entry.name));
  const file = (name: string) => input.files[name];
  const stack: string[] = [];
  const commands: string[] = [];

  const pkgText = file("package.json");
  let pkg: { scripts?: Record<string, string>; workspaces?: unknown; engines?: Record<string, string> } | undefined;
  if (pkgText) {
    try {
      pkg = JSON.parse(pkgText) as typeof pkg;
    } catch {
      pkg = undefined;
    }
  }
  if (pkg) {
    const manager = packageManager(names);
    stack.push(`${names.has("tsconfig.json") ? "TypeScript" : "JavaScript"} (Node.js, ${manager})`);
    const scripts = pkg.scripts ?? {};
    for (const script of scriptOrder)
      if (scripts[script]) commands.push(`\`${run(manager, script)}\` → ${scripts[script]?.slice(0, 80)}`);
    if (pkg.workspaces || names.has("pnpm-workspace.yaml")) stack.push("monorepo with workspaces");
  }
  const pyproject = file("pyproject.toml");
  if (pyproject || names.has("requirements.txt") || names.has("setup.py")) {
    const tool = /\[tool\.poetry\]/.test(pyproject ?? "") ? "Poetry" : names.has("uv.lock") ? "uv" : "pip";
    stack.push(`Python (${tool})`);
    if (/\[tool\.pytest|pytest/.test(pyproject ?? "") || names.has("tests") || names.has("pytest.ini"))
      commands.push("`pytest` → tests");
    if (/\[tool\.ruff/.test(pyproject ?? "")) commands.push("`ruff check .` → lint");
    if (/\[tool\.mypy/.test(pyproject ?? "")) commands.push("`mypy .` → type check");
  }
  const make = file("Makefile");
  if (names.has("go.mod")) {
    stack.push("Go");
    commands.push("`go test ./...` → tests", "`go build ./...` → build");
  }
  if (names.has("Cargo.toml")) {
    stack.push("Rust (Cargo)");
    commands.push("`cargo test` → tests", "`cargo build` → build");
  }
  if (names.has("pom.xml")) {
    stack.push("Java (Maven)");
    commands.push("`mvn test` → tests");
  }
  if (names.has("build.gradle") || names.has("build.gradle.kts")) {
    stack.push("JVM (Gradle)");
    commands.push(`\`${names.has("gradlew") ? "./gradlew" : "gradle"} test\` → tests`);
  }
  if ([...names].some((name) => /\.(sln|csproj|fsproj)$/.test(name))) {
    stack.push(".NET");
    commands.push("`dotnet test` → tests");
  }
  if (names.has("CMakeLists.txt")) {
    stack.push("C/C++ (CMake)");
    commands.push("`cmake -B build && cmake --build build` → build");
  } else if (names.has("meson.build")) stack.push("C/C++ (Meson)");
  else if (make && [...names].some((name) => /\.(c|cc|cpp|h)$/.test(name))) stack.push("C/C++ (Make)");
  if (names.has("Gemfile")) stack.push("Ruby (Bundler)");
  if (names.has("composer.json")) stack.push("PHP (Composer)");
  if (names.has("Dockerfile") || names.has("docker-compose.yml") || names.has("compose.yaml")) stack.push("Docker");
  if ([...names].some((name) => name.endsWith(".tf")) || names.has("terraform")) stack.push("Terraform");
  if (make) for (const target of makeTargets(make)) commands.push(`\`make ${target}\``);

  const folders = input.entries
    .filter((entry) => entry.directory && !entry.name.startsWith(".") && !ignoredFolders.has(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 20)
    .map((name) => (folderPurposes[name] ? `${name}/ (${folderPurposes[name]})` : `${name}/`));
  if (names.has(".github")) folders.push(".github/ (CI and GitHub settings)");

  const notes: string[] = [];
  for (const [name, label] of [
    ["AGENTS.md", "AGENTS.md"],
    ["CONTRIBUTING.md", "CONTRIBUTING.md"],
    ["ARCHITECTURE.md", "ARCHITECTURE.md"],
  ] as const)
    if (names.has(name)) notes.push(label);
  if (names.has("docs") && file("docs/ARCHITECTURE.md") !== undefined) notes.push("docs/ARCHITECTURE.md");

  const summary = file("README.md") ? readmeSummary(file("README.md") ?? "") : undefined;
  const lines = [
    "Project overview, gathered by Phew from the files of the workspace. Check the details in the files before you rely on them.",
    summary ? `- About: ${summary}` : "",
    stack.length > 0 ? `- Stack: ${stack.join(", ")}` : "",
    commands.length > 0 ? `- Commands: ${commands.slice(0, 10).join("; ")}` : "",
    folders.length > 0 ? `- Layout: ${folders.join(", ")}` : "",
    notes.length > 0 ? `- Read for more: ${notes.join(", ")}` : "",
    input.branch ? `- Git branch: ${input.branch}` : "",
  ].filter(Boolean);
  return lines.length > 1 ? lines.join("\n") : "";
}

/** The request of /init: a draft of AGENTS.md from what the project shows, for the user to review. */
export function initRequest(existing: boolean): string {
  return [
    existing
      ? "Improve the AGENTS.md of this project so that any coding agent can start working here fast."
      : "Write an AGENTS.md for this project so that any coding agent can start working here fast.",
    "",
    "Explore first: the README, the package or build files, the folders, the tests, the CI workflows, and a few typical source files.",
    "Then write AGENTS.md at the workspace root, at most about 80 lines, with these sections when they apply:",
    "- Overview: what the project is, in two sentences.",
    "- Commands: install, build, test, a single test, lint, and format, exactly as they run here.",
    "- Layout: the main folders and what lives where.",
    "- Conventions: code style, naming, patterns, and libraries the code really uses.",
    "- Testing: where tests live and how to add one.",
    "- Gotchas: things that surprise a newcomer, such as generated files, environment variables, or slow steps.",
    "",
    "Write only what the files show. Do not invent rules. Keep it short and concrete, with real paths and commands.",
    existing
      ? "Keep what is still true in the current file, fix what is wrong, and keep any block between <!-- phew:handoff:begin --> and <!-- phew:handoff:end --> as it is."
      : "",
    "Then tell me in two sentences what you wrote. I review the file in the editor and keep or undo it.",
  ]
    .filter((line, index, all) => line !== "" || all[index - 1] !== "")
    .join("\n");
}
