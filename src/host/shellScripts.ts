import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";

/**
 * How Phew starts the shell of a chat: the user's own shell with the user's own startup files, plus a few
 * lines that print invisible marks (see core/shellMarks.ts) when a command starts and at each prompt.
 * The idea is the same as VS Code shell integration; the scripts are Phew's own and small.
 */

export interface ShellLaunch {
  readonly file: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  /** False for shells that Phew cannot mark; it then waits for a quiet prompt instead. */
  readonly integrated: boolean;
  /** "posix" is sh, dash, ash, or ksh: the prompt carries the mark, but there is no mark at the start of a command. */
  readonly kind: "bash" | "zsh" | "fish" | "pwsh" | "posix" | "other";
}

const prompt = "printf '\\033]6973;P;%s;%s\\007'";

const bash = `# Phew shell integration for bash: the user's startup files, then marks for Phew.
if [ -n "$PHEW_SKIP_RC" ]; then :; elif [ -n "$PHEW_BASH_RC" ] && [ -f "$PHEW_BASH_RC" ]; then . "$PHEW_BASH_RC"; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi
__phew_prompt() { local s=$?; ${prompt} "$s" "$PWD"; return $s; }
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND=(__phew_prompt "\${PROMPT_COMMAND[@]}")
else
  PROMPT_COMMAND="__phew_prompt\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
PS0="\${PS0}"$'\\e]6973;C\\a'
`;

const zshenv = (dir: string) => `# Phew shell integration for zsh: the user's .zshenv first.
export PHEW_USER_ZDOTDIR="\${PHEW_USER_ZDOTDIR:-$HOME}"
ZDOTDIR="$PHEW_USER_ZDOTDIR"
[ -z "$PHEW_SKIP_RC" ] && [ -f "$ZDOTDIR/.zshenv" ] && . "$ZDOTDIR/.zshenv"
PHEW_USER_ZDOTDIR="\${ZDOTDIR:-$HOME}"
ZDOTDIR="${dir}"
`;

const zprofile = (dir: string) => `ZDOTDIR="$PHEW_USER_ZDOTDIR"
[ -z "$PHEW_SKIP_RC" ] && [ -f "$ZDOTDIR/.zprofile" ] && . "$ZDOTDIR/.zprofile"
ZDOTDIR="${dir}"
`;

const zshrc = `ZDOTDIR="$PHEW_USER_ZDOTDIR"
[ -z "$PHEW_SKIP_RC" ] && [ -f "$ZDOTDIR/.zshrc" ] && . "$ZDOTDIR/.zshrc"
__phew_precmd() { local s=$?; ${prompt} "$s" "$PWD"; return $s }
__phew_preexec() { printf '\\033]6973;C\\007' }
typeset -ga precmd_functions preexec_functions
precmd_functions=(__phew_precmd $precmd_functions)
preexec_functions+=(__phew_preexec)
# Themes such as powerlevel10k rebuild the hook lists; the mark goes first again before each command.
__phew_keep() { [[ \${precmd_functions[1]} == __phew_precmd ]] || precmd_functions=(__phew_precmd \${precmd_functions:#__phew_precmd}) }
preexec_functions+=(__phew_keep)
`;

const fish = `set -g __phew_status 0
function __phew_postexec --on-event fish_postexec; set -g __phew_status $status; end
function __phew_preexec --on-event fish_preexec; printf '\\e]6973;C\\a'; end
function __phew_prompt --on-event fish_prompt; printf '\\e]6973;P;%s;%s\\a' $__phew_status $PWD; end`;

const posix = `# Phew shell integration for sh, dash, ash, and ksh: the user's $ENV file, then a mark in the prompt.
if [ -n "$PHEW_USER_ENV" ] && [ -f "$PHEW_USER_ENV" ]; then . "$PHEW_USER_ENV"; fi
PS1='$(printf "\\033]6973;P;%s;%s\\007" "$?" "$PWD")'"\${PS1:-$ }"
`;

const pwsh = `# Phew shell integration for PowerShell: a mark before the user's prompt.
$global:__PhewPrompt = $function:prompt
function global:prompt {
  $phewStatus = if ($global:?) { 0 } elseif ($global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 }
  $text = & $global:__PhewPrompt
  "$([char]27)]6973;P;$phewStatus;$($PWD.ProviderPath)$([char]7)" + $text
}
`;

/** Writes the scripts once per user into a private folder. */
function scriptsFolder(): string {
  let user = "user";
  try {
    user = userInfo().username.replace(/[^\w.-]/g, "_");
  } catch {
    // No user name on this system.
  }
  const folder = path.join(tmpdir(), `phew-shell-${user}`);
  mkdirSync(path.join(folder, "zsh"), { recursive: true, mode: 0o700 });
  const write = (name: string, text: string) => writeFileSync(path.join(folder, name), text, { mode: 0o600 });
  write("bash.sh", bash);
  write("zsh/.zshenv", zshenv(path.join(folder, "zsh")));
  write("zsh/.zprofile", zprofile(path.join(folder, "zsh")));
  write("zsh/.zshrc", zshrc);
  write("pwsh.ps1", pwsh);
  write("posix.sh", posix);
  return folder;
}

/**
 * The user's shell: the setting of Phew, then $SHELL, then a common default. A plain sh or dash becomes bash
 * when bash exists, because $SHELL of a remote VS Code server is often /bin/sh while people work in bash.
 */
export function userShell(configured: string | undefined): string {
  if (configured && existsSync(configured)) return configured;
  if (process.platform === "win32") return configured || "powershell.exe";
  const bash = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"].find((candidate) => existsSync(candidate));
  const shell = process.env.SHELL;
  if (shell && existsSync(shell)) return /\/(sh|dash)$/.test(shell) && bash ? bash : shell;
  for (const candidate of ["/bin/zsh", bash ?? "", "/bin/sh"]) if (candidate && existsSync(candidate)) return candidate;
  return "/bin/sh";
}

/**
 * How to start a shell. Without the startup files (for heavy prompt themes), the shell starts fast and
 * plain, and the marks of Phew still work.
 */
export function shellLaunch(shell: string, loadStartupFiles = true): ShellLaunch {
  const name = path
    .basename(shell)
    .toLowerCase()
    .replace(/\.exe$/, "");
  // Pagers and Git editors would wait for keys that the agent never presses.
  const env: Record<string, string> = {
    PAGER: "cat",
    GIT_PAGER: "cat",
    MANPAGER: "cat",
    GIT_EDITOR: "true",
    TERM_PROGRAM: "phew",
    ...(loadStartupFiles ? {} : { PHEW_SKIP_RC: "1" }),
  };
  try {
    const folder = scriptsFolder();
    if (name === "bash")
      return {
        file: shell,
        args: ["--init-file", path.join(folder, "bash.sh"), "-i"],
        env,
        integrated: true,
        kind: "bash",
      };
    if (name === "zsh") {
      const user = process.env.ZDOTDIR || homedir();
      return {
        file: shell,
        args: process.platform === "darwin" ? ["-l", "-i"] : ["-i"],
        env: { ...env, ZDOTDIR: path.join(folder, "zsh"), PHEW_USER_ZDOTDIR: user },
        integrated: true,
        kind: "zsh",
      };
    }
    if (name === "fish")
      return {
        file: shell,
        args: [...(loadStartupFiles ? [] : ["--no-config"]), "-i", "--init-command", fish],
        env,
        integrated: true,
        kind: "fish",
      };
    if (name === "pwsh" || name === "powershell")
      return {
        file: shell,
        args: [
          "-NoLogo",
          ...(loadStartupFiles ? [] : ["-NoProfile"]),
          "-NoExit",
          "-Command",
          `. '${path.join(folder, "pwsh.ps1").replace(/'/g, "''")}'`,
        ],
        env,
        integrated: true,
        kind: "pwsh",
      };
    if (["sh", "dash", "ash", "ksh", "mksh"].includes(name))
      return {
        file: shell,
        args: ["-i"],
        env: {
          ...env,
          ENV: path.join(folder, "posix.sh"),
          PHEW_USER_ENV: loadStartupFiles ? (process.env.ENV ?? "") : "",
        },
        integrated: true,
        kind: "posix",
      };
  } catch {
    // Without the scripts the shell still works; Phew then waits for a quiet prompt.
  }
  return { file: shell, args: process.platform === "win32" ? [] : ["-i"], env, integrated: false, kind: "other" };
}
