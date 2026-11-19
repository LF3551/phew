import { exec } from "node:child_process";
import * as os from "node:os";

/** How long a key command may run. Sign-in tools can be slow on the first run of the day. */
const timeoutMs = 60_000;

/**
 * Runs the key command of a model profile and returns what it printed. The command comes only
 * from the user settings; it runs in the home folder, not in the workspace, so a project cannot
 * put its own program in the way. The output is never logged.
 */
export function runKeyCommand(command: string, profileName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      { cwd: os.homedir(), timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const timedOut = error.killed || (error as { signal?: string }).signal === "SIGTERM";
        // Only the error output is shown: the normal output may hold a key.
        const detail = stderr.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 300);
        reject(
          new Error(
            timedOut
              ? `The key command of ${profileName} did not finish in ${timeoutMs / 1000} seconds.`
              : `The key command of ${profileName} failed${typeof error.code === "number" ? ` (exit ${error.code})` : ""}${detail ? `: ${detail}` : "."}`,
          ),
        );
      },
    );
  });
}
