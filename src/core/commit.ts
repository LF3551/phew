import { redactSecrets } from "./secrets";

export type CommitStyle = "conventional" | "simple";
export type GpgMode = "git" | "always" | "never";

export interface CommitSettings {
  readonly style: CommitStyle;
  readonly language: string;
  readonly maxSubjectLength: number;
  readonly includeBody: boolean;
  /** Add a `Signed-off-by` trailer (Developer Certificate of Origin). */
  readonly signOff: boolean;
  /** `git` follows `commit.gpgsign` of the Git configuration. */
  readonly gpgSign: GpgMode;
  /** Optional author override in the form `Name <email>`. Empty means the Git configuration. */
  readonly author: string;
  /** Extra trailers that the user configured, for example `Refs: #123`. Phew never adds co-authors by itself. */
  readonly trailers: readonly string[];
  /** Adds `Assisted-by: Phew` when the user turns it on. Off by default. */
  readonly assistedBy?: boolean;
  readonly instructions: string;
}

export interface GitIdentity {
  readonly name?: string;
  readonly email?: string;
  readonly signingKey?: string;
  readonly gpgSign?: boolean;
  readonly gpgFormat?: string;
}

const authorPattern = /^\s*([^<>]+?)\s*<([^<>\s@]+@[^<>\s]+)>\s*$/;

/** Parses `Name <email>`. */
export function parseAuthor(value: string): { name: string; email: string } | undefined {
  const match = authorPattern.exec(value);
  return match ? { name: match[1], email: match[2] } : undefined;
}

/** The identity that commits use: the author override or the Git configuration. */
export function effectiveIdentity(
  settings: CommitSettings,
  git: GitIdentity,
): { name?: string; email?: string; source: string } {
  const override = parseAuthor(settings.author);
  if (override) return { ...override, source: "phew.commit.author" };
  return { name: git.name, email: git.email, source: "Git configuration" };
}

/** True when commits are GPG or SSH signed with the current settings. */
export function willSign(settings: CommitSettings, git: GitIdentity): boolean {
  if (settings.gpgSign === "always") return true;
  if (settings.gpgSign === "never") return false;
  return git.gpgSign === true;
}

/** A human-readable summary of how Phew commits, for the settings page and approvals. */
export function describeCommitIdentity(settings: CommitSettings, git: GitIdentity): string {
  const identity = effectiveIdentity(settings, git);
  const who = identity.name || identity.email ? `${identity.name ?? "?"} <${identity.email ?? "?"}>` : "not configured";
  const signing = willSign(settings, git)
    ? `signed${git.gpgFormat ? ` (${git.gpgFormat})` : ""}${git.signingKey ? ` with key ${git.signingKey}` : ""}`
    : "not signed";
  return `Author: ${who} from ${identity.source}. Commits are ${signing}${settings.signOff ? ", with Signed-off-by" : ""}.`;
}

const maximumDiff = 60_000;

/** Builds the messages that ask the model for a commit message. */
export function buildCommitMessages(diff: string, settings: CommitSettings, recentSubjects: readonly string[] = []) {
  const rules = [
    settings.style === "conventional"
      ? "Use the Conventional Commits format: type(scope): subject. Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert."
      : "Write a plain imperative subject line, for example 'Fix login timeout'.",
    `Write in ${settings.language || "English"}.`,
    `Keep the subject line at most ${settings.maxSubjectLength} characters, in the imperative mood, without a final period.`,
    settings.includeBody
      ? "After a blank line, add a short body that explains what changed and why, wrapped at 72 characters. Skip the body for trivial changes."
      : "Write only the subject line.",
    "Do not add trailers, co-authors, sign-offs, or issue numbers that are not in the diff.",
    "Return only the commit message, without code fences or quotes.",
    settings.instructions ? `Extra rules from the user: ${settings.instructions}` : "",
  ].filter(Boolean);
  const examples =
    recentSubjects.length > 0
      ? `\n\nRecent commit subjects in this repository, for style:\n${recentSubjects
          .slice(0, 10)
          .map((s) => `- ${s}`)
          .join("\n")}`
      : "";
  const safeDiff = redactSecrets(
    diff.length > maximumDiff ? `${diff.slice(0, maximumDiff)}\n[Diff truncated]` : diff,
  ).text;
  return [
    { role: "system" as const, content: `You write Git commit messages.\n${rules.join("\n")}${examples}` },
    { role: "user" as const, content: `Write the commit message for this diff:\n\n${safeDiff}` },
  ];
}

/** Cleans the model output and adds the trailers that the user configured. */
export function finalizeCommitMessage(
  raw: string,
  settings: CommitSettings,
  identity: { name?: string; email?: string },
): string {
  let message = raw.trim();
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(message);
  if (fenced) message = fenced[1].trim();
  message = message.replace(/^["'`]+|["'`]+$/g, "").trim();
  // Never keep co-author or sign-off trailers that the model invented.
  message = message
    .split("\n")
    .filter((line) => !/^(co-authored-by|signed-off-by|assisted-by):/i.test(line.trim()))
    .join("\n")
    .trim();
  const [subject, ...rest] = message.split("\n");
  let body = rest.join("\n").trim();
  if (!settings.includeBody) body = "";
  const trailers = [...settings.trailers.map((trailer) => trailer.trim()).filter(Boolean)];
  if (settings.assistedBy && !trailers.some((trailer) => /^assisted-by:/i.test(trailer)))
    trailers.push("Assisted-by: Phew");
  if (settings.signOff && identity.name && identity.email)
    trailers.push(`Signed-off-by: ${identity.name} <${identity.email}>`);
  return [subject.trim(), body, trailers.join("\n")].filter(Boolean).join("\n\n");
}

/** Adds the configured flags to a `git commit` command of the agent. Other commands do not change. */
export function adjustAgentGitCommand(command: string, settings: CommitSettings): { command: string; notes: string[] } {
  if (!/^\s*git\s+(-[Cc]\s+\S+\s+)*commit\b/.test(command)) return { command, notes: [] };
  let result = command.trimEnd();
  const notes: string[] = [];
  if (settings.signOff && !/(\s-s\b|\s--signoff\b|\s-[a-zA-Z]*s[a-zA-Z]*\b)/.test(result)) {
    result += " --signoff";
    notes.push("Phew added --signoff (phew.commit.signOff).");
  }
  if (settings.gpgSign === "always" && !/\s(-S|--gpg-sign)\b/.test(result)) {
    result += " --gpg-sign";
    notes.push("Phew added --gpg-sign (phew.commit.gpgSign).");
  } else if (settings.gpgSign === "never" && !/--no-gpg-sign\b/.test(result)) {
    result += " --no-gpg-sign";
    notes.push("Phew added --no-gpg-sign (phew.commit.gpgSign).");
  }
  const author = parseAuthor(settings.author);
  if (author && !/\s--author[=\s]/.test(result)) {
    result += ` --author=${JSON.stringify(`${author.name} <${author.email}>`)}`;
    notes.push(`Phew set the author ${author.name} <${author.email}> (phew.commit.author).`);
  }
  return { command: result, notes };
}
