/** A step's markers share rows in up to this many columns. */
export const ANNOTATION_MAX_COLUMNS = 3;
/** In columns a marker may wrap to this many lines; one that needs more keeps the list in fewer columns. */
const MAX_LINES_IN_COLUMN = 2;

/**
 * Splits `heights`, in order, into at most `columns` runs, each no taller than
 * `capacity`. Returns how many fit and the index each run starts at.
 */
export function fillColumns(heights: readonly number[], columns: number, capacity: number): { count: number; starts: number[] } {
  const starts: number[] = [];
  let index = 0;
  for (let first = heights[index]; starts.length < columns && first !== undefined && first <= capacity; first = heights[index]) {
    starts.push(index);
    let used = 0;
    for (let next = heights[index]; next !== undefined && used + next <= capacity; next = heights[index]) {
      used += next;
      index += 1;
    }
  }
  return { count: index, starts };
}

/** The shortest column height that takes every one of `heights`, in order, in `columns` runs. */
export function balancedColumnHeight(heights: readonly number[], columns: number): number {
  // The answer is always the height of some run of consecutive items.
  const runs = new Set<number>();
  heights.forEach((_, start) => {
    let sum = 0;
    for (const height of heights.slice(start)) {
      sum += height;
      runs.add(sum);
    }
  });
  const candidates = [...runs].sort((left, right) => left - right);
  let low = 0;
  let high = candidates.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    // low <= middle < high, so middle is inside candidates.
    if (fillColumns(heights, columns, candidates[middle]!).count === heights.length) high = middle;
    else low = middle + 1;
  }
  return candidates[low] ?? 0;
}

export interface AnnotationColumns<Line> {
  columns: number;
  /** Each marker's lines: in its column, or across the full width when it spans. */
  lines: Line[][];
  /** Markers laid out across the full width, between runs of columns. */
  spans: boolean[];
}

/**
 * Which markers run across the full width in `columns` columns: those that
 * would wrap past two lines in a column, and those left between them in a run
 * too short to give every column two markers (numbered down short columns,
 * such a run would read out of order).
 */
function spanningMarkers(lineCounts: readonly number[], columns: number): boolean[] {
  const spans = lineCounts.map((lines) => lines > MAX_LINES_IN_COLUMN);
  let runStart = 0;
  for (let index = 0; index <= spans.length; index += 1) {
    if (index < spans.length && !spans[index]) continue;
    if (index - runStart < columns * 2) spans.fill(true, runStart, index);
    runStart = index + 1;
  }
  return spans;
}

/** Height of a list whose runs between spanning markers are each balanced across the columns. */
function columnListHeight(heights: readonly number[], spans: readonly boolean[], columns: number): number {
  let total = 0;
  let run: number[] = [];
  for (const [index, height] of heights.entries()) {
    if (!spans[index]) {
      run.push(height);
      continue;
    }
    total += balancedColumnHeight(run, columns) + height;
    run = [];
  }
  return total + balancedColumnHeight(run, columns);
}

/**
 * How a step's markers are laid out, numbered down each column. Another column
 * narrows every description, so it is only taken when it makes the list at least
 * two one-line markers shorter than the best with fewer columns. A marker that
 * would wrap past two lines in a column runs across the full width instead,
 * between the columns (see `spanningMarkers`). `wrap(columns)` gives each
 * marker's lines in that many columns, `height(lines)` the height of a marker of that many lines.
 */
export function chooseAnnotationColumns<Line>(
  wrap: (columns: number) => Line[][],
  height: (lines: number) => number,
): AnnotationColumns<Line> {
  const fullWidth = wrap(1);
  const single = { columns: 1, lines: fullWidth, spans: fullWidth.map(() => false) };
  let best = { layout: single, height: fullWidth.reduce((sum, lines) => sum + height(lines.length), 0) };
  const worthAnotherColumn = 2 * height(1);
  for (let columns = 2; columns <= ANNOTATION_MAX_COLUMNS; columns += 1) {
    const narrow = wrap(columns);
    const spans = spanningMarkers(narrow.map((item) => item.length), columns);
    const lines = narrow.map((item, index) => {
      const wide = fullWidth[index];
      return spans[index] && wide ? wide : item;
    });
    const listHeight = columnListHeight(lines.map((item) => height(item.length)), spans, columns);
    if (best.height - listHeight >= worthAnotherColumn) best = { layout: { columns, lines, spans }, height: listHeight };
  }
  return best.layout;
}
