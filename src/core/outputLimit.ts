/**
 * Limits for the output of commands. A command can print millions of lines, so every layer keeps a bounded
 * part and says what it left out: the start (where errors about the setup often are) and the end (where the
 * result is). The full output always stays in the terminal.
 */

/** Keeps the first and the last characters of a growing text, and counts the lines in between. */
export class OutputKeeper {
  private head = "";
  private tail = "";
  private omittedLines = 0;
  private omittedChars = 0;

  constructor(
    private readonly headLimit = 8_000,
    private readonly tailLimit = 48_000,
  ) {}

  push(text: string): void {
    if (this.head.length < this.headLimit) {
      const room = this.headLimit - this.head.length;
      this.head += text.slice(0, room);
      text = text.slice(room);
    }
    if (!text) return;
    this.tail += text;
    if (this.tail.length > this.tailLimit * 1.5) {
      const cut = this.tail.length - this.tailLimit;
      const dropped = this.tail.slice(0, cut);
      this.omittedLines += countLines(dropped);
      this.omittedChars += dropped.length;
      this.tail = this.tail.slice(cut);
    }
  }

  get omitted(): number {
    return this.omittedLines;
  }

  text(): string {
    if (this.omittedChars === 0) return this.head + this.tail;
    return `${this.head}\n… ${this.omittedLines.toLocaleString("en-US")} lines left out; the full output is in the terminal …\n${this.tail}`;
  }
}

function countLines(text: string): number {
  let lines = 0;
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) lines++;
  return lines;
}

/** The output for the model: a short start and a longer end, so a huge log does not fill the context. */
export function limitForModel(output: string, headLimit = 3_000, tailLimit = 12_000): string {
  if (output.length <= headLimit + tailLimit) return output;
  const head = output.slice(0, headLimit);
  const tail = output.slice(-tailLimit);
  const lines = countLines(output.slice(headLimit, output.length - tailLimit));
  return `${head}\n… ${lines.toLocaleString("en-US")} lines left out (in the terminal of the chat) …\n${tail}`;
}

/**
 * Live output for the chat, at most a few screens per update. When a command prints faster than the chat can
 * show, the chat gets the newest part and a dim note about the skipped lines.
 */
export function limitForChat(text: string, limit = 24_000): string {
  if (text.length <= limit) return text;
  const skipped = countLines(text.slice(0, text.length - limit));
  return `\r\n\x1b[2m… ${skipped.toLocaleString("en-US")} lines skipped here; the terminal has all of them …\x1b[0m\r\n${text.slice(-limit)}`;
}
