/** How Phew treats a shell command that the agent wants to run. */
export type CommandDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "ask"; readonly reason?: string }
  | { readonly kind: "deny"; readonly reason: string };

export interface CommandPolicySettings {
  /** Command prefixes that run without a confirmation, for example `npm test`. */
  readonly autoApprove: readonly string[];
  /** Command prefixes that never run. */
  readonly deny: readonly string[];
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
 * Decides whether a command runs, needs a confirmation, or is blocked.
 * Dangerous and compound commands always need a confirmation, even when a prefix is auto-approved.
 */
export function decideCommand(rawCommand: string, settings: CommandPolicySettings): CommandDecision {
  const command = normalize(rawCommand);
  if (command.length === 0) return { kind: "deny", reason: "The command is empty." };
  const denied = settings.deny.find((prefix) => matchesPrefix(command, prefix));
  if (denied) return { kind: "deny", reason: `The command matches the blocked prefix "${denied}".` };
  const danger = findDanger(command);
  if (danger) return { kind: "ask", reason: `Dangerous command: ${danger}.` };
  if (isCompound(command)) return { kind: "ask", reason: "The command chains, pipes, or redirects other commands." };
  if (settings.autoApprove.some((prefix) => matchesPrefix(command, prefix))) return { kind: "allow" };
  return { kind: "ask" };
}
