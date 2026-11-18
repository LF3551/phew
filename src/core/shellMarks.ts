/**
 * The protocol between Phew and the shell of a chat. Small scripts in the shell (see shellScripts.ts)
 * print invisible OSC sequences: one when a command starts, and one at each prompt with the exit code
 * and the folder. Terminals ignore unknown OSC sequences, and Phew removes them before it shows the text.
 */

/** `ESC ] 6973 ; P ; <exit> ; <cwd> BEL` at each prompt, `ESC ] 6973 ; C BEL` when a command starts. */
export const oscPrefix = "\u001b]6973;";

export type ShellMark =
  | { readonly kind: "prompt"; readonly exitCode: number; readonly cwd: string }
  | { readonly kind: "start" };

export type ShellPiece = { readonly text: string } | { readonly mark: ShellMark };

/**
 * Splits the output of the terminal into text and marks. A mark can arrive in two chunks, so the parser
 * keeps an unfinished sequence until the next chunk.
 */
export class ShellMarkParser {
  private pending = "";

  push(chunk: string): ShellPiece[] {
    let data = this.pending + chunk;
    this.pending = "";
    const pieces: ShellPiece[] = [];
    for (;;) {
      const start = data.indexOf(oscPrefix);
      if (start < 0) {
        // Keep a possible beginning of a sequence at the end of the chunk.
        const tail = possiblePrefixTail(data);
        if (tail > 0) {
          this.pending = data.slice(data.length - tail);
          data = data.slice(0, data.length - tail);
        }
        if (data) pieces.push({ text: data });
        return pieces;
      }
      const end = findTerminator(data, start + oscPrefix.length);
      if (!end) {
        if (start > 0) pieces.push({ text: data.slice(0, start) });
        this.pending = data.slice(start);
        // A sequence without an end for this long is not ours: show it as it is.
        if (this.pending.length > 4096) {
          pieces.push({ text: this.pending });
          this.pending = "";
        }
        return pieces;
      }
      if (start > 0) pieces.push({ text: data.slice(0, start) });
      const body = data.slice(start + oscPrefix.length, end.index);
      const mark = parseMark(body);
      if (mark) pieces.push({ mark });
      data = data.slice(end.index + end.length);
    }
  }
}

function findTerminator(data: string, from: number): { index: number; length: number } | undefined {
  const bell = data.indexOf("\u0007", from);
  const st = data.indexOf("\u001b\\", from);
  if (bell < 0 && st < 0) return undefined;
  if (bell >= 0 && (st < 0 || bell < st)) return { index: bell, length: 1 };
  return { index: st, length: 2 };
}

function possiblePrefixTail(data: string): number {
  for (let length = Math.min(oscPrefix.length - 1, data.length); length > 0; length--) {
    if (oscPrefix.startsWith(data.slice(data.length - length))) return length;
  }
  return 0;
}

function parseMark(body: string): ShellMark | undefined {
  if (body === "C") return { kind: "start" };
  if (body.startsWith("P;")) {
    const rest = body.slice(2);
    const separator = rest.indexOf(";");
    const code = Number.parseInt(separator < 0 ? rest : rest.slice(0, separator), 10);
    return {
      kind: "prompt",
      exitCode: Number.isFinite(code) ? code : 0,
      cwd: separator < 0 ? "" : rest.slice(separator + 1),
    };
  }
  return undefined;
}

const ESC = "\u001b";
const BEL = "\u0007";
/** CSI and OSC sequences, character set switches, and keypad modes. */
const escapes = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(${BEL}|${ESC}\\\\)|${ESC}[()][A-Za-z0-9]|${ESC}[=>78]`,
  "g",
);
/** Removes control characters that are left after the sequences, except tab and line feed. */
function withoutControls(text: string): string {
  let result = "";
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code >= 32 ? code !== 127 : code === 9 || code === 10) result += character;
  }
  return result;
}

/** Terminal text as plain lines: no escape codes, no lines that a carriage return redrew, no bell. */
export function plainTerminalText(text: string): string {
  const lines = text
    .replace(escapes, "")
    .replace(/\r+\n/g, "\n")
    .split("\n")
    .map((line) => {
      const parts = line.split("\r");
      return parts[parts.length - 1] ?? "";
    })
    .join("\n");
  return withoutControls(lines);
}

/**
 * True when the last line of a quiet program looks like it waits for the user: a shell prompt
 * (for example inside ssh), a question, a password prompt, or a REPL.
 */
export function looksLikePrompt(output: string): boolean {
  const lines = plainTerminalText(output).split("\n");
  let last = "";
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index]?.trim()) {
      last = lines[index] ?? "";
      break;
    }
  }
  if (!last) return false;
  if (/password|passphrase|passcode|token|\(y\/n\)|\[y\/n\]|\[yes\/no\]|\(yes\/no\)|press (enter|any key)/i.test(last))
    return true;
  // Shell and REPL prompts end with one of these characters and a space or nothing.
  return /([$#%>❯➜»:?]|>>>|\.\.\.)\s?$/.test(last) && last.length < 200;
}

/** The last line that is not empty, for messages such as "waits for input: Password:". */
export function lastLine(output: string): string {
  const lines = plainTerminalText(output)
    .split("\n")
    .map((line) => line.trimEnd());
  for (let index = lines.length - 1; index >= 0; index--) if (lines[index]) return lines[index] ?? "";
  return "";
}
