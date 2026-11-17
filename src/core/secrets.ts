/** File name patterns that usually contain secrets. Matching is case-insensitive on the path segments. */
const sensitiveNamePatterns: readonly RegExp[] = [
  /^\.env(\..*)?$/,
  /^\.envrc$/,
  /^\.netrc$/,
  /^\.npmrc$/,
  /^\.pypirc$/,
  /^\.git-credentials$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|tfstate|tfvars)$/,
  /^credentials(\.json)?$/,
  /^secrets?\.(json|ya?ml|toml)$/,
  /^service[-_]?account.*\.json$/,
  /^kubeconfig$/,
];

const sensitiveDirectories: readonly string[] = [".ssh", ".aws", ".gnupg", ".kube", ".docker"];

/** True when a workspace-relative path probably contains secrets. */
export function isSensitivePath(relativePath: string, extraNames: readonly string[] = []): boolean {
  const segments = relativePath.replace(/\\/g, "/").toLowerCase().split("/").filter(Boolean);
  if (segments.some((segment) => sensitiveDirectories.includes(segment))) return true;
  const name = segments.at(-1) ?? "";
  if (name === ".env.example" || name === ".env.sample" || name === ".env.template") return false;
  if (sensitiveNamePatterns.some((pattern) => pattern.test(name))) return true;
  return extraNames.some((extra) => extra.length > 0 && name.includes(extra.toLowerCase()));
}

interface SecretRule {
  readonly label: string;
  /** Each pattern must use the global flag. */
  readonly pattern: RegExp;
  /** Builds the replacement from the match groups. The default hides the whole match. */
  readonly replace?: (groups: readonly string[]) => string;
}

const secretWords = "password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret";

/** Common secret formats. */
const secretRules: readonly SecretRule[] = [
  {
    label: "private key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  },
  { label: "AWS access key", pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: "GitHub token", pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { label: "GitLab token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { label: "Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: "Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { label: "OpenAI key", pattern: /\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g },
  { label: "Stripe key", pattern: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/g },
  { label: "JSON Web Token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    label: "credential in URL",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi,
    replace: (groups) => `${groups[1]}[REDACTED]@`,
  },
  {
    // A quoted value after a secret-like key: password = "…", "token": "…".
    label: "secret value",
    pattern: new RegExp(`(["']?[\\w.-]*(?:${secretWords})[\\w.-]*["']?\\s*[:=]\\s*)(["'])([^"'\\s]{8,})\\2`, "gi"),
    replace: (groups) => `${groups[1]}${groups[2]}[REDACTED]${groups[2]}`,
  },
  {
    // An unquoted value in .env, shell, or YAML style: DB_PASSWORD=…, api_key: ….
    label: "secret value",
    pattern: new RegExp(
      `^(\\s*(?:export\\s+)?[\\w.-]*(?:${secretWords})[\\w.-]*\\s*[:=]\\s*)([^\\s"'#(){}\\[\\],;$]{8,})\\s*$`,
      "gim",
    ),
    replace: (groups) => `${groups[1]}[REDACTED]`,
  },
];

export interface RedactionResult {
  readonly text: string;
  /** Labels of the secret types that were removed. */
  readonly found: readonly string[];
}

/** Replaces values that look like secrets before text is sent to a model. */
export function redactSecrets(text: string): RedactionResult {
  const found = new Set<string>();
  let result = text;
  for (const rule of secretRules) {
    result = result.replace(rule.pattern, (...groups: string[]) => {
      found.add(rule.label);
      return rule.replace ? rule.replace(groups) : `[REDACTED ${rule.label}]`;
    });
  }
  return { text: result, found: [...found] };
}
