import { isSensitivePath } from "./secrets";
/** How Phew treats a shell command that the agent wants to run. */
export type CommandDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "ask"; readonly reason?: string }
  | { readonly kind: "deny"; readonly reason: string };

/**
 * How commands run without a confirmation:
 * `ask` always asks, `allowlist` runs only the listed prefixes, and `safe` runs every command that is not
 * dangerous and not chained. Dangerous commands always ask.
 */
export type AutoApproveMode = "ask" | "allowlist" | "safe";

export interface CommandPolicySettings {
  readonly mode?: AutoApproveMode;
  /** Command prefixes that run without a confirmation, for example `npm test`. */
  readonly autoApprove: readonly string[];
  /** Command prefixes that never run. */
  readonly deny: readonly string[];
  /** More file names that hold secrets, from the privacy settings. */
  readonly sensitiveNames?: readonly string[];
}

/**
 * The first file that a command names and that probably holds secrets, such as `~/.aws/credentials`, `.env`, or
 * an SSH key: the same files that the read tool refuses. Quoted paths, `--file=.env`, `@.env`, and `HEAD:.env`
 * count too.
 */
export function secretFileIn(command: string, extraNames: readonly string[] = []): string | undefined {
  const words = command
    .split(/[\s|;&<>()]+/)
    .map((word) => word.replace(/^['"]+|['"]+$/g, ""))
    // `--file=.env`, and `HEAD:.env` of git show or `host:~/.ssh/id_rsa` of scp.
    .flatMap((word) => [word, ...word.split(/[=:]/).slice(1)])
    .map((word) => word.replace(/^@/, ""))
    .filter((word) => word && !word.startsWith("-"));
  for (const word of words) {
    const path = word.replace(/^(~|\$HOME|\$\{HOME\})\//, "").replace(/^\.\//, "");
    if (path && isSensitivePath(path, extraNames)) return word;
  }
  return undefined;
}

interface DangerRule {
  readonly pattern: RegExp;
  readonly reason: string;
}

/** Commands that can destroy data, leak secrets, or change shared systems. */
const dangerRules: readonly DangerRule[] = [
  { pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive|--force)\b/i, reason: "recursive or forced delete" },
  { pattern: /\b(mkfs|fdisk|diskutil\s+erase|format\s+[a-z]:)/i, reason: "disk formatting" },
  { pattern: /\bdd\s+[^|]*\bof=/i, reason: "raw disk write" },
  { pattern: /\bgit\s+push\b[^|;&]*(\s-f\b|--force)/i, reason: "force push" },
  { pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/i, reason: "discards local changes" },
  { pattern: /\bgit\s+push\b/i, reason: "publishes commits to a remote" },
  { pattern: /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/i, reason: "publishes a package" },
  { pattern: /\bkubectl\s+(delete|drain|cordon|replace\s+--force)\b/i, reason: "changes a Kubernetes cluster" },
  { pattern: /\bhelm\s+(uninstall|delete|rollback)\b/i, reason: "changes a Helm release" },
  { pattern: /\bterraform\s+(apply|destroy|import|state\s+rm)\b/i, reason: "changes cloud infrastructure" },
  { pattern: /\b(gcloud|aws|az)\b[^|;&]*\b(delete|remove|destroy|terminate)\b/i, reason: "deletes cloud resources" },
  { pattern: /\bdocker\s+(system\s+prune|volume\s+rm|rm\s+-f)\b/i, reason: "deletes Docker data" },
  { pattern: /\b(drop\s+(table|database)|truncate\s+table)\b/i, reason: "deletes database data" },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i, reason: "runs a downloaded script" },
  { pattern: /\bsudo\b/i, reason: "runs with administrator rights" },
  { pattern: /\bchmod\s+(-R\s+)?777\b|\bchown\s+-R\b/i, reason: "changes file permissions widely" },
  { pattern: /(^|[;&|]\s*)(shutdown|reboot|halt)\b/i, reason: "stops the computer" },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, reason: "fork bomb" },
  { pattern: /\b(printenv|env)\b\s*($|[|;&>])|\bcat\b[^|;&]*\.(env|pem|key)\b/i, reason: "can expose secrets" },
];

/** Returns the reason why a command is dangerous, or undefined. */
export function findDanger(command: string): string | undefined {
  return dangerRules.find((rule) => rule.pattern.test(command))?.reason;
}

function normalize(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/** Matches a prefix on a word boundary, so `npm test` matches `npm test -- --watch` but not `npm testx`. */
function matchesPrefix(command: string, prefix: string): boolean {
  const normalizedPrefix = normalize(prefix);
  if (normalizedPrefix.length === 0) return false;
  return command === normalizedPrefix || command.startsWith(`${normalizedPrefix} `);
}

/** True when the command chains or substitutes other commands. */
export function isCompound(command: string): boolean {
  return /[;&|`\n]|\$\(|>\s*[^&]/.test(command);
}

/**
 * Commands that only read: they run without asking in the default mode. A subcommand with a flag that changes something (for example `find -delete`) is not read-only.
 */
const readOnlyCommands = new Set([
  "ls",
  "ll",
  "la",
  "pwd",
  "cd",
  "echo",
  "printf",
  "cat",
  "bat",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "column",
  "nl",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "find",
  "fd",
  "tree",
  "du",
  "df",
  "date",
  "cal",
  "hostname",
  "whoami",
  "id",
  "groups",
  "uname",
  "uptime",
  "which",
  "where",
  "type",
  "command",
  "file",
  "stat",
  "ps",
  "pgrep",
  "lsof",
  "jq",
  "yq",
  "diff",
  "cmp",
  "comm",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "sha1sum",
  "sha256sum",
  "md5sum",
  "shasum",
  "md5",
  "true",
  "false",
  "test",
  "[",
  "sleep",
  "seq",
  "nproc",
  "free",
  "vm_stat",
  "sw_vers",
  "lsb_release",
  "locale",
  "tty",
]);

/** Git subcommands that only read. `git branch` and `git tag` only list without a name or a mutating flag. */
const readOnlyGit = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "describe",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "shortlog",
  "reflog",
  "grep",
  "cat-file",
  "count-objects",
  "whatchanged",
  "name-rev",
  "merge-base",
  "config --get",
]);

/** Flags that turn a read-only command into one that changes files or runs other commands. */
const writingFlags = /(^|\s)(-delete|-exec(dir)?|-ok(dir)?|-fprint\S*|-fls)(\s|$)/;

/** Splits a command into subcommands at `&&`, `||`, `;`, `|`, `&`, and line breaks, outside quotes. */
export function splitCommand(command: string): { parts: string[]; substitution: boolean } {
  const parts: string[] = [];
  let current = "";
  let quote: string | undefined;
  let substitution = false;
  for (let index = 0; index < command.length; index++) {
    const character = command[index] ?? "";
    const next = command[index + 1] ?? "";
    if (quote) {
      if (character === "\\" && quote === '"') {
        current += character + next;
        index++;
        continue;
      }
      if (quote === '"' && (character === "`" || (character === "$" && next === "("))) substitution = true;
      if (character === quote) quote = undefined;
      current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === "`" || (character === "$" && next === "(")) substitution = true;
    // `2>&1` and `&>` are redirections, not separators.
    const redirection = character === "&" && (command[index - 1] === ">" || next === ">");
    if (!redirection && (character === ";" || character === "\n" || character === "|" || character === "&")) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      if ((character === "|" || character === "&") && next === character) index++;
      continue;
    }
    current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return { parts, substitution };
}

/**
 * Output redirections write a file, except to /dev/null, between streams, or into the temporary folder
 * (/tmp, $TMPDIR), where scratch files of a task belong.
 */
function writesFile(part: string): boolean {
  const withoutHarmless = part.replace(
    /&?\d?>>?\s*(\/dev\/null|\/tmp\/[^\s;|&]*|\$\{?TMPDIR\}?\/[^\s;|&]*)|\d?>&\d/g,
    "",
  );
  return /(^|[^<])>/.test(withoutHarmless.replace(/'[^']*'|"[^"]*"/g, ""));
}

/** Leading `VAR=value` assignments and `env`-less wrappers do not change what a command is. */
function commandWords(part: string): string[] {
  const words = part
    .replace(/'[^']*'|"[^"]*"/g, "S")
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 0 && /^[A-Za-z_]\w*=/.test(words[0] ?? "")) words.shift();
  while (words[0] === "time" || words[0] === "nice" || words[0] === "command") words.shift();
  return words;
}

/** True when a subcommand only reads: a known read-only program, git that reads, or `--version` and `--help`. */
export function isReadOnly(part: string): boolean {
  if (writesFile(part) || writingFlags.test(part)) return false;
  const words = commandWords(part);
  const program = (words[0] ?? "").replace(/^.*\//, "");
  if (!program) return true;
  if (words.length === 2 && /^(--version|-v|-V|--help|-h|version)$/.test(words[1] ?? "")) return true;
  if (readOnlyCommands.has(program)) return true;
  if (program === "git") {
    const rest = words.slice(1).filter((word) => !/^-C$|^--no-pager$/.test(word));
    const sub = rest[0] ?? "";
    if (readOnlyGit.has(sub) || readOnlyGit.has(`${sub} ${rest[1] ?? ""}`.trim())) return true;
    // Listing branches, tags, remotes, and stashes reads; giving a name creates or deletes.
    if (["branch", "tag", "remote", "stash"].includes(sub))
      return (
        rest.length === 1 || rest.slice(1).every((word) => /^(-a|-r|-v|-vv|--list|-l|--all|list|show)$/.test(word))
      );
    return false;
  }
  return false;
}

/** The prefix for "Always allow": two words for tools with subcommands (`npm test`), else the program. */
export function allowPrefix(command: string): string | undefined {
  const { parts, substitution } = splitCommand(normalize(command));
  if (parts.length !== 1 || substitution || findDanger(command)) return undefined;
  const words = commandWords(parts[0] ?? "");
  const program = words[0];
  if (!program) return undefined;
  const withSubcommand =
    /^(git|npm|pnpm|yarn|npx|bun|deno|go|cargo|python3?|pip3?|uv|poetry|docker|kubectl|helm|gcloud|aws|az|make|dotnet|mvn|gradle|terraform|gh|swift|rustup|composer|bundle|rails|php|node)$/;
  const second = words[1];
  if (withSubcommand.test(program) && second && !second.startsWith("-")) return `${program} ${second}`;
  return program;
}

/**
 * Decides whether a command runs, needs a confirmation, or is blocked.
 * - `ask` asks for every command.
 * - `allowlist` runs a command when each part is read-only or in the allowlist, without file writes or `$(…)`.
 * - `safe` runs every command that is not dangerous, also chains, pipes, and redirections.
 * Dangerous commands always ask, and denied prefixes never run.
 */
export function decideCommand(rawCommand: string, settings: CommandPolicySettings): CommandDecision {
  const command = normalize(rawCommand);
  if (command.length === 0) return { kind: "deny", reason: "The command is empty." };
  const { parts, substitution } = splitCommand(command);
  for (const part of parts.length > 0 ? parts : [command]) {
    const denied = settings.deny.find((prefix) => matchesPrefix(normalize(part), prefix));
    if (denied) return { kind: "deny", reason: `The command matches the blocked prefix "${denied}".` };
  }
  const danger = findDanger(command);
  if (danger) return { kind: "ask", reason: `Dangerous command: ${danger}.` };
  // Like a dangerous command, a command that touches a file with secrets always asks, whatever the mode.
  const secret = secretFileIn(command, settings.sensitiveNames);
  if (secret) return { kind: "ask", reason: `The command uses ${secret}, which may hold secrets.` };
  const mode = settings.mode ?? "allowlist";
  if (mode === "ask") return { kind: "ask" };
  if (mode === "safe") return { kind: "allow" };
  if (substitution) return { kind: "ask", reason: "The command runs other commands inside $(…) or backticks." };
  const allowed = (part: string) =>
    !writesFile(part) &&
    (isReadOnly(part) || settings.autoApprove.some((prefix) => matchesPrefix(normalize(part), prefix)));
  const blocked = parts.find((part) => !allowed(part));
  if (!blocked) return { kind: "allow" };
  return {
    kind: "ask",
    reason: writesFile(blocked) ? "The command writes a file." : undefined,
  };
}

/** Why a command ran without asking, in a few words for the chat: "read-only", "allowlist: npm test", "All". */
export function whyAllowed(rawCommand: string, settings: CommandPolicySettings): string {
  const command = normalize(rawCommand);
  if ((settings.mode ?? "allowlist") === "safe") return "All mode: not dangerous";
  const { parts } = splitCommand(command);
  const listed = parts
    .map((part) => settings.autoApprove.find((prefix) => matchesPrefix(normalize(part), prefix)))
    .filter((prefix): prefix is string => prefix !== undefined);
  if (listed.length === 0) return parts.length > 1 ? "every part only reads" : "only reads";
  return `your allowlist: ${[...new Set(listed)].join(", ")}`;
}
