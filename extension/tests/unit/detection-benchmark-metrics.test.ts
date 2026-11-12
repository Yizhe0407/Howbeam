import { describe, expect, it } from 'vitest';
import {
  fitPreviewFrame,
  intersectionOverUnion,
  quantile,
  summarizeBenchmark,
  summarizePercentiles,
  type AccuracyResult,
  type ReplayResult,
} from '../benchmarks/detection/metrics';

describe('detection benchmark metrics', () => {
  it('computes overlap and clamps padded preview frames to the viewport', () => {
    expect(
      intersectionOverUnion({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 0, width: 10, height: 10 }),
    ).toBeCloseTo(1 / 3);
    expect(intersectionOverUnion({ x: 0, y: 0, width: -10, height: 10 }, { x: 0, y: 0, width: 10, height: 10 })).toBe(
      0,
    );
    expect(fitPreviewFrame({ x: 2, y: 4, width: 20, height: 10 }, { width: 24, height: 16 })).toEqual({
      x: 0,
      y: 0,
      width: 24,
      height: 16,
    });
  });

  it('uses interpolated percentiles and stable empty summaries', () => {
    expect(quantile([40, 10, 30, 20], 0.5)).toBe(25);
    expect(quantile([10, 20], 0.95)).toBeCloseTo(19.5);
    expect(summarizePercentiles([])).toEqual({
      samples: 0,
      min: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
    });
  });

  it('separates exact and semantic accuracy and summarizes replay fidelity', () => {
    const expected = { x: 0, y: 0, width: 10, height: 10 };
    const accuracy: AccuracyResult[] = [
      {
        id: 'exact',
        category: 'control',
        mode: 'activation',
        status: 'exact',
        exactIoU: 1,
        bestIoU: 1,
        latencySamplesMs: [8, 10],
        actual: expected,
        expected,
      },
      {
        id: 'semantic',
        category: 'control',
        mode: 'activation',
        status: 'semantic',
        exactIoU: 0.5,
        bestIoU: 0.95,
        latencySamplesMs: [12],
        actual: expected,
        expected,
      },
      {
        id: 'miss',
        category: 'surface',
        mode: 'annotation',
        status: 'miss',
        exactIoU: 0,
        bestIoU: 0,
        latencySamplesMs: [20],
        actual: null,
        expected,
      },
    ];
    const replay: ReplayResult[] = [
      {
        id: 'pass',
        category: 'control',
        passed: true,
        latencyMs: 50,
        boundsIoU: 1,
        expectedCount: 1,
        observedCount: 1,
        forbiddenCounts: {},
      },
      {
        id: 'fail',
        category: 'frame',
        passed: false,
        latencyMs: 70,
        boundsIoU: 0.5,
        expectedCount: 1,
        observedCount: 2,
        forbiddenCounts: { underlay: 1 },
      },
    ];

    const summary = summarizeBenchmark(accuracy, replay);
    expect(summary.activation).toMatchObject({
      cases: 2,
      exact: 1,
      semantic: 2,
      exactAccuracy: 0.5,
      semanticAccuracy: 1,
      medianIoU: 0.98,
    });
    expect(summary.annotation).toMatchObject({ cases: 1, miss: 1, semanticAccuracy: 0 });
    expect(summary.replay).toMatchObject({
      cases: 2,
      passed: 1,
      exactlyOnceRate: 0.5,
      medianBoundsIoU: 0.75,
    });
    expect(summary.replay.latency.p50).toBe(60);
  });
});
