/**
 * The input line of a running command. A command of the agent has no TTY, so the terminals of Phew
 * (in the chat and in the panel) edit the line themselves: they echo the keys, send the line on Enter,
 * stop the command on Ctrl+C, and close its input on Ctrl+D.
 */
export interface LineActions {
  /** Shows text in every terminal of the command. */
  readonly echo: (text: string) => void;
  readonly submit: (line: string) => void;
  readonly interrupt: () => void;
  readonly endOfInput: () => void;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences start with a control character.
const escapeSequence = /\u001b(\[[0-9;?]*[@-~]|O.|.)/g;

export class LineEditor {
  private line = "";

  constructor(private readonly actions: LineActions) {}

  feed(data: string): void {
    // Pasted text with line breaks sends each line.
    // Arrow keys and other escape sequences do nothing in a line without a TTY.
    const keys = data.replace(escapeSequence, "").replace(/\r\n/g, "\r").replace(/\n/g, "\r");
    for (const character of keys) {
      if (character === "\u0003") {
        this.line = "";
        this.actions.echo("^C\r\n");
        this.actions.interrupt();
      } else if (character === "\u0004") {
        this.actions.echo("^D\r\n");
        if (this.line) {
          this.actions.submit(this.line);
          this.line = "";
        }
        this.actions.endOfInput();
      } else if (character === "\r") {
        this.actions.echo("\r\n");
        this.actions.submit(`${this.line}\n`);
        this.line = "";
      } else if (character === "\u007f" || character === "\b") {
        if (this.line) {
          this.line = [...this.line].slice(0, -1).join("");
          this.actions.echo("\b \b");
        }
      } else if (character >= " ") {
        this.line += character;
        this.actions.echo(character);
      }
    }
  }
}
