/**
 * Parses a Server-Sent Events stream into `data` payloads.
 * Feed text chunks in order and call `flush` at the end.
 */
export class SseParser {
  private buffer = "";
  private data: string[] = [];

  constructor(private readonly onData: (data: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.search(/\r?\n/);
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      const length = this.buffer[newline] === "\r" ? 2 : 1;
      this.buffer = this.buffer.slice(newline + length);
      this.line(line);
      newline = this.buffer.search(/\r?\n/);
    }
  }

  flush(): void {
    if (this.buffer.length > 0) this.line(this.buffer);
    this.buffer = "";
    this.dispatch();
  }

  private line(line: string): void {
    if (line === "") {
      this.dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
  }

  private dispatch(): void {
    if (this.data.length === 0) return;
    const data = this.data.join("\n");
    this.data = [];
    this.onData(data);
  }
}
