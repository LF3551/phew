import { redactSecrets } from "./secrets";

/**
 * "Phew: Report a Problem": a bug report with what a maintainer needs (versions, system, shell, model, settings,
 * and the recent log) and without what is private (secrets, the user name, the home folder, and the folders of
 * the project). The user reads it before anything leaves the computer.
 */

export interface ReportFacts {
  readonly phew: string;
  readonly editor: { readonly name: string; readonly version: string; readonly remote?: string };
  readonly os: { readonly platform: string; readonly release: string; readonly arch: string };
  readonly language: string;
  readonly shell: {
    readonly path: string;
    readonly terminal: string;
    readonly startupFiles: boolean;
    /** What self-healing did in this window, for example "bash: without startup files". */
    readonly healing: readonly string[];
    /** Why the terminal library did not load, when it did not. */
    readonly ptyError?: string;
  };
  readonly model?: { readonly provider: string; readonly model: string };
  /** Settings that are safe to share: modes and switches, never addresses or lists. */
  readonly settings: Readonly<Record<string, string | number | boolean>>;
  readonly log: readonly string[];
}

export interface PrivateParts {
  readonly home?: string;
  readonly user?: string;
  readonly workspaces: readonly string[];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Removes secrets, the home folder, the user name, and the folders of the project from a text. */
export function sanitize(text: string, parts: PrivateParts): string {
  let result = redactSecrets(text).text;
  // The longest paths first, so a project inside the home folder becomes <workspace>, not ~/….
  const folders = [...parts.workspaces].filter((folder) => folder.length > 1).sort((a, b) => b.length - a.length);
  for (const [index, folder] of folders.entries()) {
    const name = folders.length > 1 ? `<workspace ${index + 1}>` : "<workspace>";
    for (const form of new Set([folder, folder.replace(/\\/g, "/")]))
      result = result.replace(new RegExp(escapeRegExp(form), "gi"), name);
  }
  if (parts.home && parts.home.length > 1)
    for (const form of new Set([parts.home, parts.home.replace(/\\/g, "/")]))
      result = result.replace(new RegExp(escapeRegExp(form), "gi"), "~");
  if (parts.user && parts.user.length > 2)
    result = result.replace(new RegExp(`(?<![\\w-])${escapeRegExp(parts.user)}(?![\\w-])`, "gi"), "<user>");
  return result;
}

/** The report in Markdown, ready for a GitHub issue. */
export function buildReport(facts: ReportFacts, description: string, parts: PrivateParts): string {
  const settings = Object.entries(facts.settings)
    .map(([key, value]) => `| \`${key}\` | ${String(value)} |`)
    .join("\n");
  const shell = [
    `- Shell: \`${facts.shell.path}\`, terminal: ${facts.shell.terminal}, startup files: ${facts.shell.startupFiles ? "on" : "off"}`,
    facts.shell.healing.length > 0 ? `- Self-healing: ${facts.shell.healing.join("; ")}` : "",
    facts.shell.ptyError ? `- Terminal library: ${facts.shell.ptyError}` : "",
  ].filter(Boolean);
  const text = [
    "## What happened",
    "",
    description.trim() || "_Describe what you did, what you expected, and what happened instead._",
    "",
    "## Environment",
    "",
    `- Phew ${facts.phew}`,
    `- ${facts.editor.name} ${facts.editor.version}${facts.editor.remote ? ` (remote: ${facts.editor.remote})` : ""}`,
    `- ${facts.os.platform} ${facts.os.release} (${facts.os.arch}), language ${facts.language}`,
    ...shell,
    facts.model ? `- Model: ${facts.model.provider}, \`${facts.model.model}\`` : "- Model: none connected",
    "",
    "## Settings",
    "",
    "| Setting | Value |",
    "| --- | --- |",
    settings,
    "",
    "## Recent log",
    "",
    "```text",
    facts.log.length > 0 ? facts.log.join("\n") : "(empty)",
    "```",
    "",
    "_Made by Phew: Report a Problem. Secrets, the user name, the home folder, and the folders of the project are removed._",
  ].join("\n");
  return sanitize(text, parts);
}

/** The short fields of the bug report form of the repository, from the facts. */
export function formFields(facts: ReportFacts, description: string, parts: PrivateParts): Record<string, string> {
  return {
    what: sanitize(description.trim(), parts),
    phew: facts.phew,
    vscode: `${facts.editor.name} ${facts.editor.version}${facts.editor.remote ? ` (remote: ${facts.editor.remote})` : ""}`,
    model: facts.model ? `${facts.model.provider} ${facts.model.model}` : "none connected",
    os: `${facts.os.platform} ${facts.os.release} (${facts.os.arch})`,
  };
}

/**
 * The address of a new issue in the bug report form (.github/ISSUE_TEMPLATE/bug_report.yml), with its fields filled
 * in by their ids; the whole report goes to the logs field. Browsers and GitHub cut long addresses, so a long report
 * stays out of the address: Phew copies it to the clipboard, and the field asks to paste it.
 */
export function issueUrl(
  repository: string,
  title: string,
  fields: Readonly<Record<string, string>>,
  report: string,
  limit = 7000,
): { readonly url: string; readonly complete: boolean } {
  const make = (values: Readonly<Record<string, string>>) => {
    const query = new URLSearchParams({ template: "bug_report.yml", title, ...values });
    return `https://github.com/${repository}/issues/new?${query.toString()}`;
  };
  const full = make({ ...fields, logs: report });
  if (full.length <= limit) return { url: full, complete: true };
  const what = (fields.what ?? "").slice(0, 2000);
  return {
    url: make({ ...fields, what, logs: "Phew copied the full report to the clipboard: paste it here." }),
    complete: false,
  };
}
