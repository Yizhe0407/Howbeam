import { expect, type Frame, type Locator, type Page } from '@playwright/test';
import { inflateSync } from 'node:zlib';
// Type-only import: erased at runtime (Playwright never loads extension code), but keeps the project template below from drifting off the model.
import type { Project } from '../../../lib/storage/models';
import { firstItems, itemAt } from '../../setup/item-at';

/** Browser 內的 page.evaluate 無法匯入 Node 模組，因此在此集中管理持久化契約字面值。 */
const SCRIBE_DB = { name: 'howbeam', version: 2 } as const;
// `as const` keeps the literal types non-widening so the typed chrome.storage.local.get overloads still apply inside evaluate bodies.
export const RECORDING_STATE_KEY = 'howbeam:recordingState' as const;
const ACTIVE_PROJECT_ID_KEY = 'howbeam:activeProjectId' as const;

/** Pristine project row seeded by resetExtensionData; `satisfies` fails the typecheck if the Project model (via createProject) gains or renames a field. */
const E2E_PROJECT_TEMPLATE = {
  title: 'E2E 測試教學',
  description: '',
  sections: [],
  createdAt: 0,
  updatedAt: 0,
  contentRevision: 0,
  stepEditRevision: 0,
  metadataRevision: 0,
  stepCount: 0,
  entryCount: 0,
  storageBytes: 0,
} satisfies Omit<Project, 'id'>;

declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
  };
  storage: {
    local: {
      clear(): Promise<void>;
      get(key: 'howbeam:recordingState'): Promise<Record<string, { isRecording?: boolean } | undefined>>;
      get(key: string): Promise<Record<string, unknown>>;
      set(values: Record<string, unknown>): Promise<void>;
    };
  };
  downloads: {
    search(query: { orderBy?: string[]; limit?: number }): Promise<Array<{
      filename: string;
      mime?: string;
      state: string;
    }>>;
  };
};

export type RecordingMode = 'steps' | 'snapshot';

function decodePngRgba(input: Buffer): { width: number; height: number; channels: number; pixels: Uint8Array } {
  if (input.readUInt32BE(0) !== 0x89504e47 || input.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('Expected a PNG screenshot.');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const chunks: Buffer[] = [];
  while (offset < input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.toString('ascii', offset + 4, offset + 8);
    const data = input.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
    } else if (type === 'IDAT') {
      chunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error('Only 8-bit RGB/RGBA PNG screenshots are supported.');
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw.readUInt8(source++);
    const rowStart = y * stride;
    const previousStart = rowStart - stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? itemAt(pixels, rowStart + x - channels) : 0;
      const above = y > 0 ? itemAt(pixels, previousStart + x) : 0;
      const upperLeft = y > 0 && x >= channels ? itemAt(pixels, previousStart + x - channels) : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = Math.floor((left + above) / 2);
      else if (filter === 4) {
        const p = left + above - upperLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - above);
        const pc = Math.abs(p - upperLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft;
      } else if (filter !== 0) {
        throw new Error(`Unsupported PNG filter ${filter}.`);
      }
      pixels[rowStart + x] = (raw.readUInt8(source++) + predictor) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

export async function readPageScreenshotPixel(
  page: Page,
  clientX: number,
  clientY: number,
): Promise<{ red: number; green: number; blue: number; alpha: number }> {
  const [screenshot, viewport] = await Promise.all([
    page.screenshot({ type: 'png' }),
    page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
  ]);
  const decoded = decodePngRgba(screenshot);
  const x = Math.min(decoded.width - 1, Math.max(0, Math.floor(clientX * decoded.width / viewport.width)));
  const y = Math.min(decoded.height - 1, Math.max(0, Math.floor(clientY * decoded.height / viewport.height)));
  const index = (y * decoded.width + x) * decoded.channels;
  return {
    red: itemAt(decoded.pixels, index),
    green: itemAt(decoded.pixels, index + 1),
    blue: itemAt(decoded.pixels, index + 2),
    alpha: decoded.channels === 4 ? itemAt(decoded.pixels, index + 3) : 255,
  };
}

export async function readRootScrollbarSentinelPixels(page: Page): Promise<number> {
  const decoded = decodePngRgba(await page.screenshot({ type: 'png' }));
  const stripWidth = Math.min(24, decoded.width);
  let count = 0;
  for (let y = 0; y < decoded.height; y += 1) {
    for (let x = decoded.width - stripWidth; x < decoded.width; x += 1) {
      const index = (y * decoded.width + x) * decoded.channels;
      const red = itemAt(decoded.pixels, index);
      const green = itemAt(decoded.pixels, index + 1);
      const blue = itemAt(decoded.pixels, index + 2);
      if (
        (red > 170 && green < 100 && blue > 170) ||
        (red < 100 && green > 170 && blue < 100) ||
        (red < 100 && green > 170 && blue > 170) ||
        (red > 170 && green > 170 && blue < 100)
      ) count += 1;
    }
  }
  return count;
}

export interface StoredStep {
  id: string;
  sessionId: string;
  order: number;
  description: string;
  bounds: { x: number; y: number; width: number; height: number } | null;
  groupId?: string;
  screenshotScale?: number;
  devicePixelRatio: number;
  hasScreenshot: boolean;
}

export async function resetExtensionData(popup: Page): Promise<void> {
  await popup.evaluate(async ({ scribeDb, recordingStateKey, activeProjectIdKey, projectTemplate }) => {
    const projectId = crypto.randomUUID();
    const state = await chrome.storage.local.get(recordingStateKey);
    if (state[recordingStateKey]?.isRecording) {
      await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
    }
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(scribeDb.name, scribeDb.version);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Howbeam IndexedDB reset was blocked.'));
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('steps')) {
          const steps = db.createObjectStore('steps', { keyPath: 'id' });
          steps.createIndex('by-session', 'sessionId');
        }
        if (!db.objectStoreNames.contains('projects')) {
          const projects = db.createObjectStore('projects', { keyPath: 'id' });
          projects.createIndex('by-updated-at', 'updatedAt');
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const storeNames = ['projects', 'steps'].filter((name) => db.objectStoreNames.contains(name));
        if (storeNames.length !== 2) {
          db.close();
          reject(new Error(`Howbeam IndexedDB v${scribeDb.version} stores are incomplete.`));
          return;
        }
        const tx = db.transaction(storeNames, 'readwrite');
        for (const storeName of storeNames) tx.objectStore(storeName).clear();
        tx.objectStore('projects').add({ id: projectId, ...projectTemplate });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('Reset transaction was aborted.'));
      };
    });
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      [activeProjectIdKey]: projectId,
    });
  }, {
    scribeDb: SCRIBE_DB,
    recordingStateKey: RECORDING_STATE_KEY,
    activeProjectIdKey: ACTIVE_PROJECT_ID_KEY,
    projectTemplate: E2E_PROJECT_TEMPLATE,
  });
  await popup.reload({ waitUntil: 'domcontentloaded' });
}

/** Adds another pristine Project (same shape as resetExtensionData) and selects it, so a spec can record into a different Project, as a popup start always does. */
export async function seedAndSelectProject(popup: Page, title: string): Promise<string> {
  return popup.evaluate(async ({ scribeDb, activeProjectIdKey, projectTemplate, projectTitle }) => {
    const projectId = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(scribeDb.name, scribeDb.version);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('projects', 'readwrite');
        tx.objectStore('projects').add({ id: projectId, ...projectTemplate, title: projectTitle, updatedAt: Date.now() });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('Project seed transaction was aborted.'));
      };
    });
    await chrome.storage.local.set({ [activeProjectIdKey]: projectId });
    return projectId;
  }, {
    scribeDb: SCRIBE_DB,
    activeProjectIdKey: ACTIVE_PROJECT_ID_KEY,
    projectTemplate: E2E_PROJECT_TEMPLATE,
    projectTitle: title,
  });
}

export async function readRecordingState(popup: Page): Promise<Record<string, unknown>> {
  return popup.evaluate(async (recordingStateKey) => {
    const result = await chrome.storage.local.get(recordingStateKey);
    return (result[recordingStateKey] ?? {}) as Record<string, unknown>;
  }, RECORDING_STATE_KEY);
}

export async function readSteps(popup: Page): Promise<StoredStep[]> {
  return popup.evaluate(async (scribeDb) => {
    return await new Promise<StoredStep[]>((resolve, reject) => {
      const request = indexedDB.open(scribeDb.name, scribeDb.version);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const all = db.transaction('steps', 'readonly').objectStore('steps').getAll();
        all.onerror = () => reject(all.error);
        all.onsuccess = () => {
          resolve(
            all.result.map((step) => ({
              id: step.id,
              sessionId: step.sessionId,
              order: step.order,
              description: step.description,
              bounds: step.bounds,
              groupId: step.groupId,
              screenshotScale: step.screenshotScale,
              devicePixelRatio: step.devicePixelRatio,
              hasScreenshot: step.screenshotBlob instanceof Blob,
            })).sort((first, second) => first.order - second.order),
          );
          db.close();
        };
      };
    });
  }, SCRIBE_DB);
}

export async function readLatestDownload(popup: Page): Promise<{
  filename: string;
  mime?: string;
  state: string;
} | null> {
  return popup.evaluate(async () => {
    const [download] = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 });
    return download ?? null;
  });
}

export async function rawScreenshotRosePixels(
  popup: Page,
  stepId: string,
  boundsOverride?: { x: number; y: number; width: number; height: number },
): Promise<number> {
  return popup.evaluate(async ({ id, boundsOverride, scribeDb }) => {
    return await new Promise<number>((resolve, reject) => {
      const request = indexedDB.open(scribeDb.name, scribeDb.version);
      request.onerror = () => reject(request.error);
      request.onsuccess = async () => {
        const db = request.result;
        const all = db.transaction('steps', 'readonly').objectStore('steps').getAll();
        all.onerror = () => reject(all.error);
        all.onsuccess = async () => {
          const step = all.result.find((candidate) => candidate.id === id);
          const sampleBounds = boundsOverride ?? step?.bounds;
          if (!step?.screenshotBlob || !sampleBounds) {
            db.close();
            reject(new Error(`Screenshot ${id} was not found`));
            return;
          }
          const bitmap = await createImageBitmap(step.screenshotBlob);
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Canvas context is unavailable');
          context.drawImage(bitmap, 0, 0);
          bitmap.close();
          const scale = step.screenshotScale || step.devicePixelRatio || 1;
          const left = Math.max(0, Math.floor((sampleBounds.x - 10) * scale));
          const top = Math.max(0, Math.floor((sampleBounds.y - 10) * scale));
          const right = Math.min(canvas.width, Math.ceil((sampleBounds.x + sampleBounds.width + 10) * scale));
          const bottom = Math.min(canvas.height, Math.ceil((sampleBounds.y + sampleBounds.height + 10) * scale));
          const pixels = context.getImageData(left, top, right - left, bottom - top).data;
          let rosePixels = 0;
          for (let index = 0; index < pixels.length; index += 4) {
            // Runs in the page, where test helpers are not available.
            const red = pixels[index] ?? 0;
            const green = pixels[index + 1] ?? 0;
            const blue = pixels[index + 2] ?? 0;
            if (red > 180 && red - green > 60 && red - blue > 20) rosePixels++;
          }
          db.close();
          resolve(rosePixels);
        };
      };
    });
  }, { id: stepId, boundsOverride, scribeDb: SCRIBE_DB });
}

/** Adds a green box that a CSS animation sweeps across the page, far faster
 * than a screenshot round trip, so any gap between reading its box and taking
 * the pixels shows up as a box over blank page. */
export async function addMovingTarget(page: Page): Promise<void> {
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = `
      @keyframes moving-target-sweep { from { transform: translateX(0); } to { transform: translateX(900px); } }
      #moving-target { position: fixed; left: 40px; top: 300px; width: 120px; height: 60px; background: rgb(0, 200, 0); animation: moving-target-sweep 600ms linear infinite alternate; }
    `;
    const box = document.createElement('div');
    box.id = 'moving-target';
    document.head.append(style);
    document.body.append(box);
  });
}

/** Whether the stored screenshot is the moving target's green at the centre
 * and just inside the left and right edges of `bounds`. */
export async function storedScreenshotShowsMovingTarget(
  popup: Page,
  stepId: string,
  bounds: { x: number; y: number; width: number; height: number },
): Promise<boolean> {
  return popup.evaluate(async ({ id, bounds, scribeDb }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(scribeDb.name, scribeDb.version);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const step = await new Promise<{ screenshotBlob?: Blob; screenshotScale?: number; devicePixelRatio?: number } | undefined>((resolve, reject) => {
      const get = db.transaction('steps', 'readonly').objectStore('steps').get(id);
      get.onerror = () => reject(get.error);
      get.onsuccess = () => resolve(get.result);
    });
    db.close();
    if (!step?.screenshotBlob) throw new Error(`Screenshot ${id} was not found`);
    const bitmap = await createImageBitmap(step.screenshotBlob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas context is unavailable');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const scale = step.screenshotScale || step.devicePixelRatio || 1;
    const y = bounds.y + bounds.height / 2;
    return [bounds.x + 14, bounds.x + bounds.width / 2, bounds.x + bounds.width - 14].every((x) => {
      const [red, green, blue] = context.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data;
      return (red ?? 255) < 40 && (green ?? 0) > 160 && (blue ?? 255) < 40;
    });
  }, { id: stepId, bounds, scribeDb: SCRIBE_DB });
}

export async function readScreenshotScrollbarStats(popup: Page, stepId: string): Promise<{
  width: number;
  height: number;
  rootSentinelPixels: number;
  nestedSentinelPixels: number;
}> {
  return popup.evaluate(async ({ id, scribeDb }) => {
    return await new Promise<{
      width: number;
      height: number;
      rootSentinelPixels: number;
      nestedSentinelPixels: number;
    }>((resolve, reject) => {
      const request = indexedDB.open(scribeDb.name, scribeDb.version);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const all = db.transaction('steps', 'readonly').objectStore('steps').getAll();
        all.onerror = () => reject(all.error);
        all.onsuccess = async () => {
          try {
            const step = all.result.find((candidate) => candidate.id === id);
            if (!step?.screenshotBlob) throw new Error(`Screenshot ${id} was not found`);
            const bitmap = await createImageBitmap(step.screenshotBlob);
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Canvas context is unavailable');
            context.drawImage(bitmap, 0, 0);
            const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
            const rootStripWidth = Math.min(24, bitmap.width);
            let rootSentinelPixels = 0;
            let nestedSentinelPixels = 0;
            for (let index = 0; index < pixels.length; index += 4) {
              // Runs in the page, where test helpers are not available.
              const red = pixels[index] ?? 0;
              const green = pixels[index + 1] ?? 0;
              const blue = pixels[index + 2] ?? 0;
              const x = (index / 4) % bitmap.width;
              const magenta = red > 170 && green < 100 && blue > 170;
              const greenTrack = red < 100 && green > 170 && blue < 100;
              const cyanButton = red < 100 && green > 170 && blue > 170;
              const yellowCorner = red > 170 && green > 170 && blue < 100;
              if (
                x >= bitmap.width - rootStripWidth &&
                (magenta || greenTrack || cyanButton || yellowCorner)
              ) {
                rootSentinelPixels++;
              }
              const orangeThumb = red > 180 && green > 50 && green < 170 && blue < 80;
              const blueTrack = red < 80 && green > 50 && green < 160 && blue > 180;
              if (orangeThumb || blueTrack) nestedSentinelPixels++;
            }
            const result = { width: bitmap.width, height: bitmap.height, rootSentinelPixels, nestedSentinelPixels };
            bitmap.close();
            resolve(result);
          } catch (error) {
            reject(error);
          } finally {
            db.close();
          }
        };
      };
    });
  }, { id: stepId, scribeDb: SCRIBE_DB });
}

export async function startRecording(appPage: Page, popup: Page, mode: RecordingMode): Promise<void> {
  await appPage.bringToFront();
  await popup.evaluate(async ({ mode, activeProjectIdKey }) => {
    try {
      const stored = await chrome.storage.local.get(activeProjectIdKey);
      const sessionId = stored[activeProjectIdKey];
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('No active E2E Project was initialized.');
      }
      const result = await chrome.runtime.sendMessage({
        type: 'START_RECORDING',
        sessionId,
        mode,
      }) as { ok: true } | { ok: false; error?: string } | undefined;

      if (!result?.ok) {
        throw new Error(result?.error ?? 'START_RECORDING failed without a typed result');
      }
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? `START_RECORDING rejected: ${error.message}`
          : `START_RECORDING rejected: ${String(error)}`,
      );
    }
  }, { mode, activeProjectIdKey: ACTIVE_PROJECT_ID_KEY });
  await expect.poll(async () => (await readRecordingState(popup)).isRecording).toBe(true);
  if (mode === 'steps') {
    await expect.poll(() => appPage.locator('[data-howbeam-step-preview]').count()).toBe(1);
  } else {
    await expect.poll(() => appPage.locator('[data-howbeam-snapshot-shield]').count()).toBe(1);
    await getSnapshotFrame(appPage);
  }
}

export async function stopRecording(popup: Page): Promise<void> {
  await popup.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
  });
  await expect.poll(async () => (await readRecordingState(popup)).isRecording).toBe(false);
}

/** Polls until the store holds exactly `expected` persisted steps. */
export async function expectStepCount(popup: Page, expected: number): Promise<void> {
  await expect.poll(async () => (await readSteps(popup)).length).toBe(expected);
}

/** Starts a steps run and captures its first step on the fixture page's plain-text target, returning once the step has committed. */
export async function startStepsRunWithFirstStep(appPage: Page, popup: Page): Promise<void> {
  await startRecording(appPage, popup, 'steps');
  await clickTarget(appPage, '#plain-text');
  await expectStepCount(popup, 1);
}

/** Clicks the fixture's genuine <a href> link during a steps run: the step must commit (screenshot of the OLD page) before the replayed click navigates. */
export async function captureNavLinkClickStep(appPage: Page, popup: Page): Promise<void> {
  await startRecording(appPage, popup, 'steps');
  await clickTarget(appPage, '#nav-link');
  await appPage.waitForURL('**/navigated.html');
  await expectStepCount(popup, 1);
}

/** Asserts the run survived a top-level navigation (still recording, recorder re-injected) then captures the navigated page's heading. */
export async function captureNavigatedHeadingStep(appPage: Page, popup: Page): Promise<void> {
  await expect.poll(async () => (await readRecordingState(popup)).isRecording).toBe(true);
  await expect.poll(() => appPage.locator('[data-howbeam-step-preview]').count()).toBe(1);
  const heading = appPage.getByRole('heading', { name: '已導覽到新文件' });
  const box = await heading.boundingBox();
  if (!box) throw new Error('Navigated heading has no box');
  await appPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

export async function sendRecordingControl(
  page: Page,
  type: string,
  undoToken?: string,
): Promise<{ ok: boolean; error?: string }> {
  return page.evaluate(async ({ type, undoToken, recordingStateKey }) => {
    const result = await chrome.storage.local.get(recordingStateKey);
    const runId = (result[recordingStateKey] as { runId?: string } | undefined)?.runId;
    return chrome.runtime.sendMessage({ type, runId, ...(undoToken ? { undoToken } : {}) }) as Promise<{
      ok: boolean;
      error?: string;
    }>;
  }, { type, undoToken, recordingStateKey: RECORDING_STATE_KEY });
}

/** 整個視窗反覆斷言值穩定，以捕捉 sleep-then-assert 會漏掉的短暫異常。 */
export async function expectSteady<T>(
  read: () => Promise<T>,
  expected: T,
  windowMs = 400,
): Promise<void> {
  const deadline = Date.now() + windowMs;
  do {
    // Widen to unknown: Playwright's conditional matcher types can't resolve the generic and would otherwise drop toEqual.
    const value: unknown = await read();
    expect(value).toEqual(expected);
  } while (Date.now() < deadline);
}

export async function hoverTarget(
  page: Page,
  locator: Parameters<Page['locator']>[0],
  expectedPreview: 'visible' | 'hidden' = 'visible',
): Promise<void> {
  const target = page.locator(locator);
  const box = await target.boundingBox();
  if (!box) throw new Error(`Target ${locator} has no bounding box`);
  await page.mouse.move(5, 5);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  if (expectedPreview === 'visible') {
    // Settle on the preview overlay: visible and stable across two consecutive reads, so the hover probe has won.
    await expect
      .poll(async () => {
        const first = await getStepPreviewStyle(page);
        if (first.hidden) return false;
        const second = await getStepPreviewStyle(page);
        return !second.hidden && second.style === first.style;
      })
      .toBe(true);
  } else {
    // A paused/ignoring recorder shows nothing to wait for; assert the preview stays hidden across a short polling window.
    await expectSteady(async () => (await getStepPreviewStyle(page)).hidden, true);
  }
}

export async function clickTarget(page: Page, locator: Parameters<Page['locator']>[0]): Promise<void> {
  const point = await targetCenter(page, locator);
  await page.mouse.click(point.x, point.y);
}

export async function targetCenter(
  page: Page,
  locator: Parameters<Page['locator']>[0],
): Promise<{ x: number; y: number }> {
  const box = await page.locator(locator).boundingBox();
  if (!box) throw new Error(`Target ${locator} has no bounding box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export async function getSnapshotFrame(page: Page): Promise<Frame> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const frame = page.frames().find((candidate) => candidate.url().includes('snapshot-shield.html'));
    if (frame) return frame;
    await page.waitForTimeout(50);
  }
  throw new Error('Snapshot shield frame did not become available');
}

/**
 * Clicks a shield toolbar control whose action removes the shield iframe
 * (finish, next snapshot, rebuild, discard). Any Playwright action on that
 * frame that is still pending when the app removes it never settles (a CDP
 * mouse click waits for the frame's next paint) or fails with "Frame was
 * detached". The click is queued in the frame so the evaluation returns
 * before the handler, and with it the teardown, can start.
 */
export async function clickShieldClosingControl(control: Locator): Promise<void> {
  await expect(control).toBeEnabled();
  await control.evaluate((button: HTMLElement) => {
    setTimeout(() => button.click(), 0);
  });
}

export async function clickSnapshotTarget(page: Page, point: { x: number; y: number }): Promise<void> {
  const frame = await getSnapshotFrame(page);
  await frame.locator('body').click({ position: point });
}

export async function getStepPreviewStyle(page: Page): Promise<{ hidden: boolean; style: string | null }> {
  const client = await page.context().newCDPSession(page);
  const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
  const find = (node: { attributes?: string[]; children?: unknown[]; shadowRoots?: unknown[]; contentDocument?: unknown }, predicate: (value: typeof node) => boolean): typeof node | null => {
    if (predicate(node)) return node;
    for (const collection of [node.children, node.shadowRoots, node.contentDocument ? [node.contentDocument] : undefined]) {
      for (const child of collection ?? []) {
        const found = find(child as typeof node, predicate);
        if (found) return found;
      }
    }
    return null;
  };
  const preview = find(root, (node) => {
    const attributes = node.attributes ?? [];
    const classIndex = attributes.indexOf('class');
    return classIndex >= 0 && (attributes[classIndex + 1]?.split(/\s+/).includes('preview') ?? false);
  });
  await client.detach();
  if (!preview) return { hidden: true, style: null };
  const attributes = preview.attributes ?? [];
  const styleIndex = attributes.indexOf('style');
  const style = styleIndex >= 0 ? (attributes[styleIndex + 1] ?? null) : null;
  return { hidden: style?.includes('display: none') ?? true, style };
}
/** Clicks a toolbar control by accessible name via CDP, since Playwright locators cannot pierce the closed shadow root that hosts it. */
export async function clickRecordingToolbarButton(page: Page, name: string): Promise<void> {
  interface PiercedNode {
    nodeId: number;
    attributes?: string[];
    children?: unknown[];
    shadowRoots?: unknown[];
    contentDocument?: unknown;
  }
  const client = await page.context().newCDPSession(page);
  try {
    const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
    const find = (node: PiercedNode, predicate: (value: PiercedNode) => boolean): PiercedNode | null => {
      if (predicate(node)) return node;
      for (const collection of [node.children, node.shadowRoots, node.contentDocument ? [node.contentDocument] : undefined]) {
        for (const child of collection ?? []) {
          const found = find(child as PiercedNode, predicate);
          if (found) return found;
        }
      }
      return null;
    };
    const button = find(root as PiercedNode, (node) => {
      const attributes = node.attributes ?? [];
      const labelIndex = attributes.indexOf('aria-label');
      return labelIndex >= 0 && attributes[labelIndex + 1] === name;
    });
    if (!button) throw new Error(`Recording toolbar has no control labelled ${name}`);
    const { model } = await client.send('DOM.getBoxModel', { nodeId: button.nodeId });
    const [left, top, , , right, bottom] = firstItems(model.content, 6);
    await page.mouse.click((left + right) / 2, (top + bottom) / 2);
  } finally {
    await client.detach();
  }
}
