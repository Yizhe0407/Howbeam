import { HIGHLIGHT_PADDING } from '../../../lib/media/annotation-contract';
import { itemAt } from '../../setup/item-at';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AccuracyStatus = 'exact' | 'semantic' | 'wrong' | 'miss';

export interface AccuracyResult {
  id: string;
  category: string;
  mode: 'activation' | 'annotation';
  status: AccuracyStatus;
  exactIoU: number;
  bestIoU: number;
  latencySamplesMs: number[];
  actual: Rect | null;
  expected: Rect;
}

export interface ReplayResult {
  id: string;
  category: string;
  passed: boolean;
  latencyMs: number;
  boundsIoU: number;
  expectedCount: number;
  observedCount: number;
  forbiddenCounts: Record<string, number>;
}

export interface AccuracySummary {
  cases: number;
  exact: number;
  semantic: number;
  wrong: number;
  miss: number;
  exactAccuracy: number;
  semanticAccuracy: number;
  medianIoU: number;
  latency: Percentiles;
}

export interface Percentiles {
  samples: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface BenchmarkSummary {
  activation: AccuracySummary;
  annotation: AccuracySummary;
  overall: AccuracySummary;
  replay: {
    cases: number;
    passed: number;
    exactlyOnceRate: number;
    medianBoundsIoU: number;
    latency: Percentiles;
  };
}

function safeExtent(value: number): number {
  return Number.isFinite(value) ? Math.max(value, 0) : 0;
}

export function intersectionOverUnion(first: Rect, second: Rect): number {
  const firstRight = first.x + safeExtent(first.width);
  const firstBottom = first.y + safeExtent(first.height);
  const secondRight = second.x + safeExtent(second.width);
  const secondBottom = second.y + safeExtent(second.height);
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(firstRight, secondRight);
  const bottom = Math.min(firstBottom, secondBottom);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const firstArea = safeExtent(first.width) * safeExtent(first.height);
  const secondArea = safeExtent(second.width) * safeExtent(second.height);
  const union = firstArea + secondArea - intersection;
  return union > 0 ? intersection / union : 0;
}

export function fitPreviewFrame(bounds: Rect, viewport: { width: number; height: number }, padding = HIGHLIGHT_PADDING): Rect {
  const left = Math.min(Math.max(bounds.x - padding, 0), viewport.width);
  const top = Math.min(Math.max(bounds.y - padding, 0), viewport.height);
  const right = Math.min(Math.max(bounds.x + bounds.width + padding, left), viewport.width);
  const bottom = Math.min(Math.max(bounds.y + bounds.height + padding, top), viewport.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function quantile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.min(Math.max(percentile, 0), 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return itemAt(sorted, lower);
  const weight = position - lower;
  return itemAt(sorted, lower) * (1 - weight) + itemAt(sorted, upper) * weight;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

export function summarizePercentiles(values: number[]): Percentiles {
  if (values.length === 0) return { samples: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  return {
    samples: values.length,
    min: rounded(Math.min(...values)),
    p50: rounded(quantile(values, 0.5)),
    p95: rounded(quantile(values, 0.95)),
    p99: rounded(quantile(values, 0.99)),
    max: rounded(Math.max(...values)),
  };
}

function summarizeAccuracy(results: AccuracyResult[]): AccuracySummary {
  const exact = results.filter((result) => result.status === 'exact').length;
  const semanticOnly = results.filter((result) => result.status === 'semantic').length;
  const wrong = results.filter((result) => result.status === 'wrong').length;
  const miss = results.filter((result) => result.status === 'miss').length;
  const cases = results.length;
  return {
    cases,
    exact,
    semantic: exact + semanticOnly,
    wrong,
    miss,
    exactAccuracy: cases > 0 ? exact / cases : 0,
    semanticAccuracy: cases > 0 ? (exact + semanticOnly) / cases : 0,
    medianIoU: rounded(quantile(results.map((result) => result.bestIoU), 0.5)),
    latency: summarizePercentiles(results.flatMap((result) => result.latencySamplesMs)),
  };
}

export function summarizeBenchmark(accuracy: AccuracyResult[], replay: ReplayResult[]): BenchmarkSummary {
  const replayPassed = replay.filter((result) => result.passed).length;
  return {
    activation: summarizeAccuracy(accuracy.filter((result) => result.mode === 'activation')),
    annotation: summarizeAccuracy(accuracy.filter((result) => result.mode === 'annotation')),
    overall: summarizeAccuracy(accuracy),
    replay: {
      cases: replay.length,
      passed: replayPassed,
      exactlyOnceRate: replay.length > 0 ? replayPassed / replay.length : 0,
      medianBoundsIoU: rounded(quantile(replay.map((result) => result.boundsIoU), 0.5)),
      latency: summarizePercentiles(replay.map((result) => result.latencyMs)),
    },
  };
}
