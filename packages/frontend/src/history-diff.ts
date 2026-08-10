export interface HistoryChangeRange {
  readonly from: number;
  readonly to: number;
}

interface SourceLine {
  readonly end: number;
  readonly start: number;
  readonly value: string;
}

type DiffOperation = "delete" | "equal" | "insert";

const maximumEditDistance = 512;

/** Returns changed line ranges in the newer Markdown source. */
export function historyChangeRanges(
  previous: string,
  current: string,
): readonly HistoryChangeRange[] {
  if (previous === current) return [];
  const previousLines = sourceLines(previous);
  const currentLines = sourceLines(current);
  let prefix = 0;
  while (
    prefix < previousLines.length &&
    prefix < currentLines.length &&
    previousLines[prefix]?.value === currentLines[prefix]?.value
  ) {
    prefix += 1;
  }

  let previousSuffix = previousLines.length;
  let currentSuffix = currentLines.length;
  while (
    previousSuffix > prefix &&
    currentSuffix > prefix &&
    previousLines[previousSuffix - 1]?.value === currentLines[currentSuffix - 1]?.value
  ) {
    previousSuffix -= 1;
    currentSuffix -= 1;
  }

  const operations = diffOperations(
    previousLines.slice(prefix, previousSuffix).map((line) => line.value),
    currentLines.slice(prefix, currentSuffix).map((line) => line.value),
  );
  if (operations === undefined) {
    return [fallbackRange(currentLines, prefix, currentSuffix, current.length)];
  }

  const ranges: HistoryChangeRange[] = [];
  let currentIndex = prefix;
  let hunkStart: number | undefined;
  let hunkEnd: number | undefined;
  let hunkPosition = currentIndex;
  const finishHunk = (): void => {
    if (hunkStart !== undefined && hunkEnd !== undefined) {
      ranges.push({ from: hunkStart, to: hunkEnd });
    } else if (hunkStart !== undefined) {
      const position = currentLines[hunkPosition]?.start ?? current.length;
      ranges.push({ from: position, to: position });
    }
    hunkStart = undefined;
    hunkEnd = undefined;
  };

  for (const operation of operations) {
    if (operation === "equal") {
      finishHunk();
      currentIndex += 1;
      continue;
    }
    hunkStart ??= currentLines[currentIndex]?.start ?? current.length;
    hunkPosition = currentIndex;
    if (operation === "insert") {
      const inserted = currentLines[currentIndex];
      if (inserted !== undefined) hunkEnd = inserted.end;
      currentIndex += 1;
    }
  }
  finishHunk();
  return mergeRanges(ranges);
}

function sourceLines(source: string): readonly SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline === -1 ? source.length : newline + 1;
    lines.push({ end, start, value: source.slice(start, end) });
    start = end;
  }
  return lines;
}

function diffOperations(
  previous: readonly string[],
  current: readonly string[],
): readonly DiffOperation[] | undefined {
  const previousLength = previous.length;
  const currentLength = current.length;
  const maximum = Math.min(previousLength + currentLength, maximumEditDistance);
  let frontier = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];

  for (let distance = 0; distance <= maximum; distance += 1) {
    trace.push(new Map(frontier));
    const next = new Map(frontier);
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = frontier.get(diagonal + 1) ?? -1;
      const right = frontier.get(diagonal - 1) ?? -1;
      let x = diagonal === -distance || (diagonal !== distance && right < down) ? down : right + 1;
      let y = x - diagonal;
      while (x < previousLength && y < currentLength && previous[x] === current[y]) {
        x += 1;
        y += 1;
      }
      next.set(diagonal, x);
      if (x >= previousLength && y >= currentLength) {
        return backtrackOperations(trace, previousLength, currentLength, distance);
      }
    }
    frontier = next;
  }
  return undefined;
}

function backtrackOperations(
  trace: readonly ReadonlyMap<number, number>[],
  previousLength: number,
  currentLength: number,
  distance: number,
): readonly DiffOperation[] {
  const reversed: DiffOperation[] = [];
  let x = previousLength;
  let y = currentLength;

  for (let depth = distance; depth >= 0; depth -= 1) {
    const frontier = trace[depth] ?? new Map<number, number>();
    const diagonal = x - y;
    const down = frontier.get(diagonal + 1) ?? -1;
    const right = frontier.get(diagonal - 1) ?? -1;
    const previousDiagonal =
      diagonal === -depth || (diagonal !== depth && right < down) ? diagonal + 1 : diagonal - 1;
    const previousX = frontier.get(previousDiagonal) ?? 0;
    const previousY = previousX - previousDiagonal;

    while (x > previousX && y > previousY) {
      reversed.push("equal");
      x -= 1;
      y -= 1;
    }
    if (depth === 0) break;
    if (x === previousX) {
      reversed.push("insert");
      y -= 1;
    } else {
      reversed.push("delete");
      x -= 1;
    }
  }
  return reversed.toReversed();
}

function fallbackRange(
  currentLines: readonly SourceLine[],
  startIndex: number,
  endIndex: number,
  sourceLength: number,
): HistoryChangeRange {
  if (startIndex === endIndex) {
    const position = currentLines[startIndex]?.start ?? sourceLength;
    return { from: position, to: position };
  }
  return {
    from: currentLines[startIndex]?.start ?? sourceLength,
    to: currentLines[endIndex - 1]?.end ?? sourceLength,
  };
}

function mergeRanges(ranges: readonly HistoryChangeRange[]): readonly HistoryChangeRange[] {
  const merged: HistoryChangeRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.from <= previous.to) {
      merged[merged.length - 1] = { from: previous.from, to: Math.max(previous.to, range.to) };
    } else {
      merged.push(range);
    }
  }
  return merged;
}
