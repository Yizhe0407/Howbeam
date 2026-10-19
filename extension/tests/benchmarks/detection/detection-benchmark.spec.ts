import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import type { CDPSession, Frame, Page } from '@playwright/test';
import { expect, FIXTURE_URL, test } from '../../e2e/support/fixture';
import {
  getSnapshotFrame,
  readSteps,
  resetExtensionData,
  startRecording,
  stopRecording,
} from '../../e2e/support/harness';
import { ACTIVATION_CASES, ANNOTATION_CASES, REPLAY_CASES, type TargetAccuracyCase } from './cases';
import {
  fitPreviewFrame,
  intersectionOverUnion,
  summarizeBenchmark,
  type AccuracyResult,
  type AccuracyStatus,
  type BenchmarkSummary,
  type Rect,
  type ReplayResult,
} from './metrics';
import { renderMarkdown, type DetectionBenchmarkReport } from './report';

test.use({ recordTrace: false });
test.setTimeout(240_000);

const BENCHMARK_URL = `${FIXTURE_URL}benchmark.html`;
const PREVIEW_TIMEOUT_MS = 2_000;
const HOVER_SAMPLES_PER_CASE = 3;
const CAPTURE_COOLDOWN_MS = 650;
const BASELINE_PATH = path.join(process.cwd(), 'tests/benchmarks/baselines/detection.chromium.json');
const REPORT_DIRECTORY = path.join(process.cwd(), 'test-results/benchmarks');

interface BenchmarkProbe {
  rect(key: string): Rect;
  scrollIntoView(key: string): void;
  resetEvents(): void;
  readEvents(): Record<string, number>;
}

interface FrameBenchmarkProbe {
  resetEvents(): void;
  readEvents(): Record<string, number>;
}

interface BaselineFile {
  schemaVersion: 1;
  thresholds: {
    activationSemanticAccuracy: number;
    annotationSemanticAccuracy: number;
    overallMedianIoU: number;
    replayExactlyOnceRate: number;
    replayMedianBoundsIoU: number;
  };
  reference?: {
    activationSemanticAccuracy: number;
    annotationSemanticAccuracy: number;
    overallMedianIoU: number;
    replayExactlyOnceRate: number;
    replayMedianBoundsIoU: number;
    activationHoverP95Ms: number;
    annotationHoverP95Ms: number;
    replayP95Ms: number;
  };
}

interface PreviewSnapshot {
  style: string | null;
  bounds: Rect | null;
}

interface CdpNode {
  nodeId?: number;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
  contentDocument?: CdpNode;
}

function attribute(node: CdpNode, name: string): string | null {
  const attributes = node.attributes ?? [];
  const index = attributes.indexOf(name);
  return index >= 0 ? attributes[index + 1] ?? '' : null;
}

function findNode(node: CdpNode, predicate: (candidate: CdpNode) => boolean): CdpNode | null {
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  for (const shadowRoot of node.shadowRoots ?? []) {
    const found = findNode(shadowRoot, predicate);
    if (found) return found;
  }
  return node.contentDocument ? findNode(node.contentDocument, predicate) : null;
}

function parsePreviewBounds(style: string | null): Rect | null {
  if (!style || /display:\s*none/.test(style)) return null;
  const value = (property: string) => {
    const match = style.match(new RegExp(`${property}:\\s*(-?\\d+(?:\\.\\d+)?)px`));
    return match ? Number(match[1]) : null;
  };
  const x = value('left');
  const y = value('top');
  const width = value('width');
  const height = value('height');
  return x === null || y === null || width === null || height === null
    ? null
    : { x, y, width, height };
}

async function createStepPreviewReader(page: Page): Promise<{ read(): Promise<PreviewSnapshot>; close(): Promise<void> }> {
  const client: CDPSession = await page.context().newCDPSession(page);
  const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true }) as { root: CdpNode };
  const host = findNode(root, (node) => attribute(node, 'data-howbeam-step-preview') !== null);
  const preview = host
    ? findNode(host, (node) => attribute(node, 'class')?.split(/\s+/).includes('preview') ?? false)
    : null;
  if (!preview?.nodeId) {
    await client.detach();
    throw new Error('Step preview node is unavailable');
  }
  const previewNodeId = preview.nodeId;
  return {
    async read() {
      const { attributes } = await client.send('DOM.getAttributes', { nodeId: previewNodeId }) as { attributes: string[] };
      const style = attribute({ attributes }, 'style');
      return { style, bounds: parsePreviewBounds(style) };
    },
    async close() {
      await client.detach().catch(() => {});
    },
  };
}

async function probeRect(page: Page, key: string): Promise<Rect> {
  return page.evaluate((geometryKey) => {
    return (window as typeof window & { benchmarkProbe: BenchmarkProbe }).benchmarkProbe.rect(geometryKey);
  }, key);
}

async function scrollProbeIntoView(page: Page, key: string): Promise<void> {
  await page.evaluate((geometryKey) => {
    (window as typeof window & { benchmarkProbe: BenchmarkProbe }).benchmarkProbe.scrollIntoView(geometryKey);
  }, key);
  await page.waitForTimeout(50);
}

async function resetTopEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as typeof window & { benchmarkProbe: BenchmarkProbe }).benchmarkProbe.resetEvents();
  });
}

async function readTopEvents(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    return (window as typeof window & { benchmarkProbe: BenchmarkProbe }).benchmarkProbe.readEvents();
  });
}

function pointInside(rect: Rect, ratio: { x: number; y: number } = { x: 0.5, y: 0.5 }): { x: number; y: number } {
  return { x: rect.x + rect.width * ratio.x, y: rect.y + rect.height * ratio.y };
}

function statusFor(actual: Rect | null, exact: Rect, accepted: Rect[], minimumIoU: number): {
  status: AccuracyStatus;
  exactIoU: number;
  bestIoU: number;
} {
  if (!actual) return { status: 'miss', exactIoU: 0, bestIoU: 0 };
  const exactIoU = intersectionOverUnion(actual, exact);
  if (exactIoU >= minimumIoU) return { status: 'exact', exactIoU, bestIoU: exactIoU };
  const acceptedIoU = accepted.reduce((best, candidate) => Math.max(best, intersectionOverUnion(actual, candidate)), 0);
  return acceptedIoU >= minimumIoU
    ? { status: 'semantic', exactIoU, bestIoU: acceptedIoU }
    : { status: 'wrong', exactIoU, bestIoU: Math.max(exactIoU, acceptedIoU) };
}


function boundsChanged(previous: Rect | null, next: Rect | null, tolerance = 0.25): boolean {
  if (!next) return false;
  if (!previous) return true;
  return (['x', 'y', 'width', 'height'] as const).some(
    (key) => Math.abs(previous[key] - next[key]) > tolerance,
  );
}

async function waitForStepPreviewChange(
  reader: Awaited<ReturnType<typeof createStepPreviewReader>>,
  previousBounds: Rect | null,
): Promise<{ snapshot: PreviewSnapshot; latencyMs: number }> {
  const startedAt = performance.now();
  const deadline = startedAt + PREVIEW_TIMEOUT_MS;
  let latest: PreviewSnapshot = { style: null, bounds: null };
  do {
    latest = await reader.read();
    if (boundsChanged(previousBounds, latest.bounds)) {
      return { snapshot: latest, latencyMs: performance.now() - startedAt };
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  } while (performance.now() < deadline);
  return { snapshot: latest, latencyMs: performance.now() - startedAt };
}

async function runActivationCase(
  page: Page,
  reader: Awaited<ReturnType<typeof createStepPreviewReader>>,
  benchmarkCase: TargetAccuracyCase,
): Promise<AccuracyResult> {
  await scrollProbeIntoView(page, benchmarkCase.pointKey);
  const [pointRect, exactTarget, acceptedTargets, idleRect, viewport] = await Promise.all([
    probeRect(page, benchmarkCase.pointKey),
    probeRect(page, benchmarkCase.exactKey),
    Promise.all((benchmarkCase.acceptedKeys ?? []).map((key) => probeRect(page, key))),
    probeRect(page, 'benchmark-idle-target'),
    page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
  ]);
  const expected = fitPreviewFrame(exactTarget, viewport);
  const accepted = acceptedTargets.map((bounds) => fitPreviewFrame(bounds, viewport));
  const point = pointInside(pointRect, benchmarkCase.pointRatio);
  const idlePoint = pointInside(idleRect);
  const latencySamplesMs: number[] = [];
  let actual: Rect | null = null;

  for (let sample = 0; sample < HOVER_SAMPLES_PER_CASE; sample += 1) {
    const beforeIdle = await reader.read();
    await page.mouse.move(idlePoint.x, idlePoint.y);
    const idle = await waitForStepPreviewChange(reader, beforeIdle.bounds);
    const startedAt = performance.now();
    await page.mouse.move(point.x, point.y);
    const measured = await waitForStepPreviewChange(reader, idle.snapshot.bounds);
    latencySamplesMs.push(performance.now() - startedAt);
    actual = measured.snapshot.bounds;
  }

  const classification = statusFor(actual, expected, accepted, benchmarkCase.minimumIoU ?? 0.92);
  return {
    id: benchmarkCase.id,
    category: benchmarkCase.category,
    mode: 'activation',
    ...classification,
    latencySamplesMs,
    actual,
    expected,
  };
}

async function snapshotPreviewBounds(frame: Frame): Promise<Rect | null> {
  return frame.locator('.snapshot-box--preview').boundingBox();
}

async function waitForSnapshotPreviewChange(
  frame: Frame,
  previousBounds: Rect | null,
): Promise<{ bounds: Rect | null; latencyMs: number }> {
  const startedAt = performance.now();
  const deadline = startedAt + PREVIEW_TIMEOUT_MS;
  let latest: Rect | null = null;
  do {
    latest = await snapshotPreviewBounds(frame);
    if (boundsChanged(previousBounds, latest)) return { bounds: latest, latencyMs: performance.now() - startedAt };
    await new Promise((resolve) => setTimeout(resolve, 1));
  } while (performance.now() < deadline);
  return { bounds: latest, latencyMs: performance.now() - startedAt };
}

async function runAnnotationCase(
  page: Page,
  shield: Frame,
  benchmarkCase: TargetAccuracyCase,
): Promise<AccuracyResult> {
  const [pointRect, exactTarget, acceptedTargets, idleRect, viewport] = await Promise.all([
    probeRect(page, benchmarkCase.pointKey),
    probeRect(page, benchmarkCase.exactKey),
    Promise.all((benchmarkCase.acceptedKeys ?? []).map((key) => probeRect(page, key))),
    probeRect(page, 'benchmark-idle-target'),
    page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
  ]);
  const expected = fitPreviewFrame(exactTarget, viewport);
  const accepted = acceptedTargets.map((bounds) => fitPreviewFrame(bounds, viewport));
  const point = pointInside(pointRect, benchmarkCase.pointRatio);
  const idlePoint = pointInside(idleRect);
  const latencySamplesMs: number[] = [];
  let actual: Rect | null = null;

  for (let sample = 0; sample < HOVER_SAMPLES_PER_CASE; sample += 1) {
    const beforeIdle = await snapshotPreviewBounds(shield);
    await shield.locator('body').hover({ position: idlePoint });
    const idle = await waitForSnapshotPreviewChange(shield, beforeIdle);
    const startedAt = performance.now();
    await shield.locator('body').hover({ position: point });
    const measured = await waitForSnapshotPreviewChange(shield, idle.bounds);
    latencySamplesMs.push(performance.now() - startedAt);
    actual = measured.bounds;
  }

  const classification = statusFor(actual, expected, accepted, benchmarkCase.minimumIoU ?? 0.92);
  return {
    id: benchmarkCase.id,
    category: benchmarkCase.category,
    mode: 'annotation',
    ...classification,
    latencySamplesMs,
    actual,
    expected,
  };
}

async function frameForSelector(page: Page, selector: '#same-origin-frame' | '#cross-origin-frame'): Promise<Frame> {
  const iframe = await page.locator(selector).elementHandle();
  const frame = await iframe?.contentFrame();
  if (!frame) throw new Error(`Frame ${selector} is unavailable`);
  return frame;
}

async function waitForStepCount(popup: Page, count: number): Promise<number> {
  const startedAt = performance.now();
  const deadline = startedAt + 8_000;
  do {
    if ((await readSteps(popup)).length >= count) return performance.now() - startedAt;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (performance.now() < deadline);
  return performance.now() - startedAt;
}

async function runReplayCase(page: Page, popup: Page, index: number): Promise<ReplayResult> {
  const benchmarkCase = REPLAY_CASES[index];
  if (index > 0) await page.waitForTimeout(CAPTURE_COOLDOWN_MS);
  const previousSteps = await readSteps(popup);
  let point: { x: number; y: number };
  let expectedBounds: Rect;
  let readEvents: () => Promise<Record<string, number>>;

  if (benchmarkCase.frameSelector && benchmarkCase.targetSelector && benchmarkCase.expectedSelector) {
    const frame = await frameForSelector(page, benchmarkCase.frameSelector);
    await frame.locator(benchmarkCase.targetSelector).scrollIntoViewIfNeeded();
    await frame.evaluate(() => {
      (window as typeof window & { frameBenchmarkProbe: FrameBenchmarkProbe }).frameBenchmarkProbe.resetEvents();
    });
    const [pointBounds, targetBounds] = await Promise.all([
      frame.locator(benchmarkCase.targetSelector).boundingBox(),
      frame.locator(benchmarkCase.expectedSelector).boundingBox(),
    ]);
    if (!pointBounds || !targetBounds) throw new Error(`Frame target for ${benchmarkCase.id} has no bounds`);
    point = pointInside(pointBounds);
    expectedBounds = targetBounds;
    readEvents = () => frame.evaluate(() => {
      return (window as typeof window & { frameBenchmarkProbe: FrameBenchmarkProbe }).frameBenchmarkProbe.readEvents();
    });
  } else if (benchmarkCase.targetKey && benchmarkCase.expectedKey) {
    await scrollProbeIntoView(page, benchmarkCase.targetKey);
    await resetTopEvents(page);
    point = pointInside(await probeRect(page, benchmarkCase.targetKey));
    expectedBounds = await probeRect(page, benchmarkCase.expectedKey);
    readEvents = () => readTopEvents(page);
  } else {
    throw new Error(`Replay case ${benchmarkCase.id} is incomplete`);
  }

  const startedAt = performance.now();
  await page.mouse.click(point.x, point.y);
  await waitForStepCount(popup, previousSteps.length + 1);
  const latencyMs = performance.now() - startedAt;
  const [steps, events] = await Promise.all([readSteps(popup), readEvents()]);
  const captured = steps.at(-1)?.bounds ?? null;
  const boundsIoU = captured ? intersectionOverUnion(captured, expectedBounds) : 0;
  const observedCount = events[benchmarkCase.eventKey] ?? 0;
  const forbiddenCounts = Object.fromEntries(
    (benchmarkCase.forbiddenEventKeys ?? []).map((key) => [key, events[key] ?? 0]),
  );
  const forbiddenPassed = Object.values(forbiddenCounts).every((count) => count === 0);
  const passed = observedCount === 1 && forbiddenPassed && boundsIoU >= (benchmarkCase.minimumIoU ?? 0.92);
  return {
    id: benchmarkCase.id,
    category: benchmarkCase.category,
    passed,
    latencyMs,
    boundsIoU,
    expectedCount: 1,
    observedCount,
    forbiddenCounts,
  };
}

function baselineComparison(summary: BenchmarkSummary, baseline: BaselineFile): Record<string, number | string> | undefined {
  const reference = baseline.reference;
  if (!reference) return undefined;
  return {
    'activation semantic accuracy delta': summary.activation.semanticAccuracy - reference.activationSemanticAccuracy,
    'annotation semantic accuracy delta': summary.annotation.semanticAccuracy - reference.annotationSemanticAccuracy,
    'overall median IoU delta': summary.overall.medianIoU - reference.overallMedianIoU,
    'replay exactly-once delta': summary.replay.exactlyOnceRate - reference.replayExactlyOnceRate,
    'activation hover p95 ratio': reference.activationHoverP95Ms > 0
      ? summary.activation.latency.p95 / reference.activationHoverP95Ms
      : 'n/a',
    'annotation hover p95 ratio': reference.annotationHoverP95Ms > 0
      ? summary.annotation.latency.p95 / reference.annotationHoverP95Ms
      : 'n/a',
    'replay p95 ratio': reference.replayP95Ms > 0
      ? summary.replay.latency.p95 / reference.replayP95Ms
      : 'n/a',
  };
}

async function writeBaseline(summary: BenchmarkSummary, baseline: BaselineFile): Promise<void> {
  const updated: BaselineFile = {
    ...baseline,
    reference: {
      activationSemanticAccuracy: summary.activation.semanticAccuracy,
      annotationSemanticAccuracy: summary.annotation.semanticAccuracy,
      overallMedianIoU: summary.overall.medianIoU,
      replayExactlyOnceRate: summary.replay.exactlyOnceRate,
      replayMedianBoundsIoU: summary.replay.medianBoundsIoU,
      activationHoverP95Ms: summary.activation.latency.p95,
      annotationHoverP95Ms: summary.annotation.latency.p95,
      replayP95Ms: summary.replay.latency.p95,
    },
  };
  await writeFile(BASELINE_PATH, `${JSON.stringify(updated, null, 2)}\n`);
}

function currentCommit(): string {
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
  return dirty ? `${commit}-dirty` : commit;
}

test('measures target accuracy, preview latency, capture fidelity, and frame relay', async ({
  appPage,
  popupPage,
  browserErrors: _browserErrors,
}) => {
  await resetExtensionData(popupPage);
  await appPage.goto(BENCHMARK_URL, { waitUntil: 'load' });
  await expect(appPage.locator('#closed-shadow-host')).toBeVisible();
  const accuracy: AccuracyResult[] = [];
  const replay: ReplayResult[] = [];

  await startRecording(appPage, popupPage, 'steps');
  const previewReader = await createStepPreviewReader(appPage);
  try {
    for (const benchmarkCase of ACTIVATION_CASES) {
      accuracy.push(await runActivationCase(appPage, previewReader, benchmarkCase));
    }
  } finally {
    await previewReader.close();
    await stopRecording(popupPage);
  }

  await appPage.evaluate(() => window.scrollTo(0, 0));
  await startRecording(appPage, popupPage, 'snapshot');
  const shield = await getSnapshotFrame(appPage);
  try {
    for (const benchmarkCase of ANNOTATION_CASES) {
      accuracy.push(await runAnnotationCase(appPage, shield, benchmarkCase));
    }
  } finally {
    await stopRecording(popupPage);
  }

  await startRecording(appPage, popupPage, 'steps');
  try {
    for (let index = 0; index < REPLAY_CASES.length; index += 1) {
      replay.push(await runReplayCase(appPage, popupPage, index));
    }
  } finally {
    await stopRecording(popupPage);
  }

  const summary = summarizeBenchmark(accuracy, replay);
  const baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as BaselineFile;
  if (process.env.HOWBEAM_BENCHMARK_UPDATE === '1') await writeBaseline(summary, baseline);
  const report: DetectionBenchmarkReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    browser: 'Chromium',
    commit: currentCommit(),
    environment: {
      viewport: await appPage.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
      deviceScaleFactor: await appPage.evaluate(() => window.devicePixelRatio),
      headless: process.env.PW_HEADED !== '1',
    },
    summary,
    accuracy,
    replay,
    comparison: baselineComparison(summary, baseline),
  };
  await mkdir(REPORT_DIRECTORY, { recursive: true });
  await Promise.all([
    writeFile(path.join(REPORT_DIRECTORY, 'detection-benchmark.json'), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(path.join(REPORT_DIRECTORY, 'detection-benchmark.md'), renderMarkdown(report)),
  ]);

  expect(summary.activation.semanticAccuracy, 'activation semantic accuracy').toBeGreaterThanOrEqual(
    baseline.thresholds.activationSemanticAccuracy,
  );
  expect(summary.annotation.semanticAccuracy, 'annotation semantic accuracy').toBeGreaterThanOrEqual(
    baseline.thresholds.annotationSemanticAccuracy,
  );
  expect(summary.overall.medianIoU, 'overall median IoU').toBeGreaterThanOrEqual(
    baseline.thresholds.overallMedianIoU,
  );
  expect(summary.replay.exactlyOnceRate, 'replay exactly-once rate').toBeGreaterThanOrEqual(
    baseline.thresholds.replayExactlyOnceRate,
  );
  expect(summary.replay.medianBoundsIoU, 'replay median bounds IoU').toBeGreaterThanOrEqual(
    baseline.thresholds.replayMedianBoundsIoU,
  );

  if (process.env.HOWBEAM_BENCHMARK_STRICT_LATENCY === '1' && baseline.reference) {
    const activationLimit = Math.max(
      baseline.reference.activationHoverP95Ms * 1.25,
      baseline.reference.activationHoverP95Ms + 4,
    );
    const annotationLimit = Math.max(
      baseline.reference.annotationHoverP95Ms * 1.35,
      baseline.reference.annotationHoverP95Ms + 6,
    );
    const replayLimit = Math.max(
      baseline.reference.replayP95Ms * 1.5,
      baseline.reference.replayP95Ms + 150,
    );
    expect(summary.activation.latency.p95, 'activation hover p95 regression').toBeLessThanOrEqual(activationLimit);
    expect(summary.annotation.latency.p95, 'annotation hover p95 regression').toBeLessThanOrEqual(annotationLimit);
    expect(summary.replay.latency.p95, 'replay p95 regression').toBeLessThanOrEqual(replayLimit);
  }
});
