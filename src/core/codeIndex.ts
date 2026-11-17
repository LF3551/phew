/** A ranked text index for code search. It uses BM25 with identifier-aware tokens and optional embeddings. */

export interface Chunk {
  readonly path: string;
  /** First line, starting at 1. */
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

export interface SearchHit extends Chunk {
  readonly score: number;
}

const stopWords = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "are",
  "was",
  "not",
  "but",
  "you",
  "all",
  "any",
  "can",
  "const",
  "let",
  "var",
  "return",
  "function",
  "import",
  "export",
  "default",
  "new",
  "true",
  "false",
  "null",
  "undefined",
  "public",
  "private",
  "static",
  "void",
  "def",
  "self",
  "if",
  "else",
  "in",
  "of",
  "to",
  "is",
  "it",
  "where",
  "how",
  "what",
  "which",
  "does",
  "do",
]);

/** Splits text into lowercase terms. `getUserName` gives `getusername`, `get`, `user`, and `name`. */
export function tokenize(text: string): string[] {
  const terms: string[] = [];
  for (const word of text.match(/[A-Za-z_][A-Za-z0-9_]*|\d{2,}/g) ?? []) {
    const lower = word.toLowerCase();
    const parts = word
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[\s_]+/)
      .map((part) => part.toLowerCase())
      .filter((part) => part.length >= 2);
    if (lower.length >= 2 && !stopWords.has(lower)) terms.push(lower);
    if (parts.length > 1) for (const part of parts) if (!stopWords.has(part)) terms.push(part);
  }
  return terms;
}

/** Splits a file into overlapping chunks of lines. */
export function chunkFile(path: string, text: string, size = 40, overlap = 8): Chunk[] {
  const lines = text.split(/\r?\n/);
  const chunks: Chunk[] = [];
  const step = Math.max(1, size - overlap);
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + size);
    const body = lines.slice(start, end).join("\n");
    if (body.trim().length > 0) chunks.push({ path, startLine: start + 1, endLine: end, text: body });
    if (end >= lines.length) break;
  }
  return chunks;
}

interface Entry {
  readonly chunk: Chunk;
  readonly terms: Map<string, number>;
  readonly length: number;
  vector?: number[];
}

export interface SerializedIndex {
  readonly version: 1;
  readonly files: Record<
    string,
    { readonly stamp: string; readonly chunks: readonly Chunk[]; readonly vectors?: number[][] }
  >;
}

export class CodeIndex {
  private readonly files = new Map<string, { stamp: string; entries: Entry[] }>();
  private readonly documentFrequency = new Map<string, number>();
  private totalLength = 0;
  private count = 0;

  get fileCount(): number {
    return this.files.size;
  }

  get chunkCount(): number {
    return this.count;
  }

  stamp(path: string): string | undefined {
    return this.files.get(path)?.stamp;
  }

  paths(): string[] {
    return [...this.files.keys()];
  }

  /** Adds or replaces a file. `stamp` identifies the version, for example the modification time and size. */
  setFile(path: string, stamp: string, text: string, vectors?: number[][]): void {
    this.removeFile(path);
    this.addChunks(path, stamp, chunkFile(path, text), vectors);
  }

  removeFile(path: string): void {
    const file = this.files.get(path);
    if (!file) return;
    for (const entry of file.entries) {
      for (const term of entry.terms.keys()) {
        const value = (this.documentFrequency.get(term) ?? 1) - 1;
        if (value <= 0) this.documentFrequency.delete(term);
        else this.documentFrequency.set(term, value);
      }
      this.totalLength -= entry.length;
      this.count--;
    }
    this.files.delete(path);
  }

  chunks(path: string): readonly Chunk[] {
    return this.files.get(path)?.entries.map((entry) => entry.chunk) ?? [];
  }

  setVectors(path: string, vectors: number[][]): void {
    const file = this.files.get(path);
    if (!file || vectors.length !== file.entries.length) return;
    file.entries.forEach((entry, index) => {
      entry.vector = vectors[index];
    });
  }

  hasVectors(path: string): boolean {
    const file = this.files.get(path);
    return !!file && file.entries.length > 0 && file.entries.every((entry) => entry.vector !== undefined);
  }

  /**
   * Ranks chunks with BM25. With a query vector, the score mixes BM25 and cosine similarity.
   * Results contain at most two chunks per file, so one big file does not hide the others.
   */
  search(query: string, limit = 8, queryVector?: readonly number[]): SearchHit[] {
    const terms = [...new Set(tokenize(query))];
    if ((terms.length === 0 && !queryVector) || this.count === 0) return [];
    const average = this.totalLength / this.count || 1;
    const k1 = 1.2;
    const b = 0.75;
    const scored: { entry: Entry; bm25: number; cosine: number }[] = [];
    for (const file of this.files.values()) {
      for (const entry of file.entries) {
        let bm25 = 0;
        for (const term of terms) {
          const frequency = entry.terms.get(term);
          if (!frequency) continue;
          const df = this.documentFrequency.get(term) ?? 0;
          const idf = Math.log(1 + (this.count - df + 0.5) / (df + 0.5));
          bm25 += (idf * frequency * (k1 + 1)) / (frequency + k1 * (1 - b + (b * entry.length) / average));
        }
        const pathTerms = tokenize(entry.chunk.path);
        bm25 += terms.filter((term) => pathTerms.includes(term)).length * 0.5;
        const cosine = queryVector && entry.vector ? cosineSimilarity(queryVector, entry.vector) : 0;
        if (bm25 > 0 || cosine > 0) scored.push({ entry, bm25, cosine });
      }
    }
    const maxBm25 = Math.max(1e-9, ...scored.map((item) => item.bm25));
    const ranked = scored
      .map((item) => ({
        entry: item.entry,
        score: queryVector ? 0.5 * (item.bm25 / maxBm25) + 0.5 * Math.max(0, item.cosine) : item.bm25,
      }))
      .sort((a, b) => b.score - a.score);
    const perFile = new Map<string, number>();
    const hits: SearchHit[] = [];
    for (const item of ranked) {
      const used = perFile.get(item.entry.chunk.path) ?? 0;
      if (used >= 2) continue;
      perFile.set(item.entry.chunk.path, used + 1);
      hits.push({ ...item.entry.chunk, score: Math.round(item.score * 1000) / 1000 });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  toJSON(): SerializedIndex {
    const files: Record<string, { stamp: string; chunks: Chunk[]; vectors?: number[][] }> = {};
    for (const [path, file] of this.files) {
      const vectors = file.entries.every((entry) => entry.vector)
        ? file.entries.map((entry) => entry.vector as number[])
        : undefined;
      files[path] = {
        stamp: file.stamp,
        chunks: file.entries.map((entry) => entry.chunk),
        ...(vectors ? { vectors } : {}),
      };
    }
    return { version: 1, files };
  }

  static fromJSON(value: unknown): CodeIndex {
    const index = new CodeIndex();
    const data = value as Partial<SerializedIndex> | undefined;
    if (data?.version !== 1 || typeof data.files !== "object" || data.files === null) return index;
    for (const [path, file] of Object.entries(data.files)) {
      if (!file || typeof file.stamp !== "string" || !Array.isArray(file.chunks)) continue;
      index.addChunks(path, file.stamp, file.chunks, file.vectors);
    }
    return index;
  }

  private addChunks(path: string, stamp: string, chunks: readonly Chunk[], vectors?: number[][]): void {
    const entries: Entry[] = chunks.map((chunk, position) => {
      const terms = new Map<string, number>();
      const tokens = tokenize(chunk.text);
      for (const term of tokens) terms.set(term, (terms.get(term) ?? 0) + 1);
      for (const term of terms.keys()) this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      this.totalLength += tokens.length;
      this.count++;
      return { chunk, terms, length: tokens.length, vector: vectors?.[position] };
    });
    this.files.set(path, { stamp, entries });
  }
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

/** Formats search hits for the model. */
export function formatHits(hits: readonly SearchHit[]): string {
  if (hits.length === 0) return "No relevant code found. Try search_text with an exact identifier.";
  return hits
    .map((hit) => {
      const numbered = hit.text
        .split("\n")
        .map((line, index) => `${hit.startLine + index}| ${line}`)
        .join("\n");
      return `${hit.path}:${hit.startLine}-${hit.endLine} (score ${hit.score})\n${numbered}`;
    })
    .join("\n\n");
}
