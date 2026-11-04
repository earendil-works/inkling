/**
 * Search projection behavior shared by every runtime.
 *
 * Documents are split into heading-scoped passages so retrieval can point an
 * agent at a section and a line range instead of a whole document. Chunking
 * is deterministic: the same body always yields the same passages, which lets
 * indexes skip unchanged content and reuse embeddings by content digest.
 */

export type SearchVariant = "working" | "published";

export interface SearchChunk {
  readonly ordinal: number;
  /** Heading texts from the outermost section to the innermost one. */
  readonly headingPath: readonly string[];
  /** Markdown source of the passage, including its heading line. */
  readonly text: string;
  /** One-based, inclusive line numbers in the complete body. */
  readonly startLine: number;
  readonly endLine: number;
}

export interface ChunkOptions {
  /** Passages longer than this are split at paragraph boundaries. */
  readonly maxCharacters?: number | undefined;
  /** Preferred size of the pieces a long section is split into. */
  readonly targetCharacters?: number | undefined;
}

interface Section {
  readonly headingPath: readonly string[];
  readonly lines: readonly SourceLine[];
  readonly hasContent: boolean;
}

interface SourceLine {
  readonly number: number;
  readonly text: string;
  readonly fenced: boolean;
}

const headingPattern = /^ {0,3}(#{1,6})(?:[\t ]+(.*?))?(?:[\t ]+#+)?[\t ]*$/u;
const fencePattern = /^ {0,3}(`{3,}|~{3,})/u;

export function chunkMarkdown(body: string, options: ChunkOptions = {}): readonly SearchChunk[] {
  const maxCharacters = options.maxCharacters ?? 1_600;
  const targetCharacters = Math.min(options.targetCharacters ?? 1_200, maxCharacters);
  const lines = body.split("\n");
  const firstContentLine = frontmatterEnd(lines);
  const sections: Section[] = [];
  const headings: { readonly level: number; readonly text: string }[] = [];
  let current: SourceLine[] = [];
  let currentPath: readonly string[] = [];
  let hasContent = false;
  let fence: string | undefined;

  const flush = (): void => {
    if (current.length > 0) {
      sections.push({ hasContent, headingPath: currentPath, lines: current });
    }
    current = [];
    hasContent = false;
  };

  for (let index = firstContentLine; index < lines.length; index += 1) {
    const text = lines[index] ?? "";
    const line: SourceLine = { fenced: fence !== undefined, number: index + 1, text };
    const fenceMatch = fencePattern.exec(text);
    if (fence === undefined && fenceMatch?.[1] !== undefined) {
      fence = fenceMatch[1];
      current.push({ ...line, fenced: true });
      hasContent = true;
      continue;
    }
    if (fence !== undefined) {
      if (fenceMatch?.[1] !== undefined && closesFence(fence, fenceMatch[1], text)) {
        fence = undefined;
      }
      current.push({ ...line, fenced: true });
      hasContent = true;
      continue;
    }
    const heading = headingPattern.exec(text);
    if (heading?.[1] !== undefined) {
      flush();
      const level = heading[1].length;
      while ((headings.at(-1)?.level ?? 0) >= level) headings.pop();
      // A trailing `{#id}` pins the section's link ID; it is not heading text.
      const headingText = (heading[2] ?? "").replace(
        /[\t ]+\{#[\p{Letter}\p{Number}_-]+\}[\t ]*$/u,
        "",
      );
      headings.push({ level, text: headingText.trim() });
      currentPath = headings.map((entry) => entry.text).filter((entry) => entry.length > 0);
      current.push(line);
      continue;
    }
    if (text.trim().length > 0) hasContent = true;
    current.push(line);
  }
  flush();

  const meaningful = sections.filter((section) => section.hasContent);
  const selected =
    meaningful.length > 0
      ? meaningful
      : sections.filter((section) => section.lines.some((line) => line.text.trim().length > 0));
  const chunks: SearchChunk[] = [];
  for (const section of selected) {
    for (const piece of splitSection(section.lines, maxCharacters, targetCharacters)) {
      const trimmed = trimBlankLines(piece);
      const first = trimmed[0];
      const last = trimmed.at(-1);
      if (first === undefined || last === undefined) continue;
      chunks.push({
        endLine: last.number,
        headingPath: section.headingPath,
        ordinal: chunks.length,
        startLine: first.number,
        text: trimmed.map((line) => line.text).join("\n"),
      });
    }
  }
  return chunks;
}

/** Text an embedding model sees for a passage: its document and section context, then content. */
export function passageEmbeddingText(
  title: string,
  chunk: Pick<SearchChunk, "headingPath" | "text">,
  maxCharacters = 2_000,
): string {
  const context = [title, chunk.headingPath.join(" › ")]
    .filter((part) => part.length > 0)
    .join("\n");
  return `${context}\n\n${chunk.text}`.slice(0, maxCharacters);
}

/** Combines ranked result lists so items found by several retrievers rise to the top. */
export function reciprocalRankFusion<K>(
  rankings: readonly (readonly K[])[],
  constant = 60,
): ReadonlyMap<K, number> {
  const scores = new Map<K, number>();
  for (const ranking of rankings) {
    ranking.forEach((key, index) => {
      scores.set(key, (scores.get(key) ?? 0) + 1 / (constant + index + 1));
    });
  }
  return scores;
}

function frontmatterEnd(lines: readonly string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (line === "---" || line === "...") return index + 1;
  }
  return 0;
}

function closesFence(opening: string, candidate: string, line: string): boolean {
  return (
    candidate[0] === opening[0] &&
    candidate.length >= opening.length &&
    line.trim() === candidate.trim()
  );
}

function splitSection(
  lines: readonly SourceLine[],
  maxCharacters: number,
  targetCharacters: number,
): readonly (readonly SourceLine[])[] {
  if (characterCount(lines) <= maxCharacters) return [lines];
  const paragraphs: SourceLine[][] = [];
  let paragraph: SourceLine[] = [];
  for (const line of lines) {
    paragraph.push(line);
    if (!line.fenced && line.text.trim().length === 0) {
      paragraphs.push(paragraph);
      paragraph = [];
    }
  }
  if (paragraph.length > 0) paragraphs.push(paragraph);

  const pieces: SourceLine[][] = [];
  let piece: SourceLine[] = [];
  const commit = (): void => {
    if (piece.length > 0) pieces.push(piece);
    piece = [];
  };
  for (const block of paragraphs.flatMap((item) => splitOversizedBlock(item, maxCharacters))) {
    if (piece.length > 0 && characterCount(piece) + characterCount(block) > targetCharacters) {
      commit();
    }
    piece.push(...block);
  }
  commit();
  return pieces;
}

function splitOversizedBlock(
  block: readonly SourceLine[],
  maxCharacters: number,
): readonly (readonly SourceLine[])[] {
  if (characterCount(block) <= maxCharacters) return [block];
  const pieces: SourceLine[][] = [];
  let piece: SourceLine[] = [];
  for (const line of block) {
    if (line.text.length > maxCharacters) {
      if (piece.length > 0) pieces.push(piece);
      piece = [];
      for (let offset = 0; offset < line.text.length; offset += maxCharacters) {
        pieces.push([{ ...line, text: line.text.slice(offset, offset + maxCharacters) }]);
      }
      continue;
    }
    if (piece.length > 0 && characterCount(piece) + line.text.length + 1 > maxCharacters) {
      pieces.push(piece);
      piece = [];
    }
    piece.push(line);
  }
  if (piece.length > 0) pieces.push(piece);
  return pieces;
}

function characterCount(lines: readonly SourceLine[]): number {
  return lines.reduce((total, line) => total + line.text.length + 1, 0);
}

function trimBlankLines(lines: readonly SourceLine[]): readonly SourceLine[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.text.trim().length === 0) start += 1;
  while (end > start && lines[end - 1]?.text.trim().length === 0) end -= 1;
  return lines.slice(start, end);
}
