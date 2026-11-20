/**
 * Self-healing of the terminal of a chat. Phew knows where a command ends and how it exited from invisible marks
 * that its shell integration prints. When a shell sends no marks (a heavy prompt theme takes over the prompt, or a
 * startup file waits for an answer), Phew restarts the shell without the startup files of the user. When that
 * does not help either, the commands of the chat run in processes, where the exit code is exact. Each step is said
 * in the chat in one line, so nobody has to look for a setting.
 */

/** How the terminal of a chat works: with marks, a shell that never has marks, or not at all. */
export type ShellHealth = "marked" | "plain" | "broken";

/** What to do after a shell started. */
export type HealStep = "ok" | "plain" | "retry-without-startup" | "fallback";

export function nextHealStep(input: {
  /** The shell has Phew's integration (bash, zsh, fish, PowerShell). */
  readonly integrated: boolean;
  /** A prompt mark came before the time ran out. */
  readonly markSeen: boolean;
  /** The startup files of the user were loaded. */
  readonly startupFiles: boolean;
}): HealStep {
  if (!input.integrated) return "plain";
  if (input.markSeen) return "ok";
  return input.startupFiles ? "retry-without-startup" : "fallback";
}

/** The startup files of a shell, for the message: ".zshrc" rather than "the startup files". */
export function startupFilesOf(shell: string): string {
  const name = shell
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.toLowerCase()
    .replace(/\.exe$/, "");
  switch (name) {
    case "zsh":
      return ".zshrc";
    case "bash":
      return ".bashrc";
    case "fish":
      return "config.fish";
    case "pwsh":
    case "powershell":
      return "your PowerShell profile";
    default:
      return "your startup files";
  }
}

/** One line for the chat about what Phew did. */
export function healNotice(step: "without-startup" | "processes", shell: string): string {
  const files = startupFilesOf(shell);
  return step === "without-startup"
    ? `The terminal of this chat started without ${files}: with it, Phew could not see where commands end. Aliases and tools from ${files} are missing here. To fix it for good, check the prompt theme or the questions in ${files}.`
    : `The shell of this chat sends no marks even without ${files}, so its commands run in processes: the output and the exit code stay exact, and there is no live terminal. Choose another shell with phew.commands.shell.`;
}

/** The same for the model, so it does not rely on aliases that are missing. */
export function healNote(step: "without-startup" | "processes", shell: string): string {
  const files = startupFilesOf(shell);
  return step === "without-startup"
    ? `Note: the shell runs without ${files}, so aliases, functions, and PATH changes from it are missing. Use full commands.`
    : "Note: commands of this chat run in processes, not in a terminal: cd and variables do not carry over to the next command.";
}
