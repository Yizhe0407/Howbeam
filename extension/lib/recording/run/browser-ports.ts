import { browser } from 'wxt/browser';
import {
  CAPTURE_PRESENTATION_CSS,
  waitForCapturePresentationPaint,
  withCapturePresentation,
} from '../../capture/capture-presentation';
import { focusTab } from '../../runtime/navigation';
import { deleteProjectPermanently, ensureProject, getProject } from '../../storage/project-repository';
import { setActiveProjectId } from '../../storage/storage';
import { discardPendingStart } from '../../runtime/pending-start';
import {
  addStepsAfter,
  deleteStep,
  deleteStepsForRun,
  discardPendingAnchor,
  getStep,
  getStepOutlines,
} from '../../storage/step-repository';
import { queueCapture } from '../background-queues';
import { assertCaptureNotCancelled } from '../background/capture-registry';
import { clearPendingUndoRecord, readPendingUndoRecord, savePendingUndoRecord } from '../background/pending-undo-store';
import type { RecorderRuntime } from '../background/recorder-runtime';
import { resolveProjectContinuationAnchor } from '../background/source-tab';
import type { RunPorts } from './ports';
import type { RecorderConnections } from '../background/recorder-connections';

/** The run flows' ports, on the real browser and storage. */
export function createBrowserPorts(deps: {
  runtime: RecorderRuntime;
  /** The recorded tab's connection: pushes to its recorder go over it. */
  connections: RecorderConnections;
  openEditor(target: { sessionId: string; entryId: string | null }): Promise<unknown>;
}): RunPorts {
  const { runtime } = deps;
  const activeIn = async (query: Parameters<typeof browser.tabs.query>[0]) =>
    (await browser.tabs.query({ active: true, ...query }))[0];

  return {
    tabs: {
      get: (tabId) => browser.tabs.get(tabId),
      activeInCurrentWindow: () => activeIn({ currentWindow: true }),
      activeInWindow: (windowId) => activeIn({ windowId }),
      activeInFocusedWindow: () => activeIn({ lastFocusedWindow: true }),
      focus: (tabId, windowId) => focusTab(tabId, windowId),
      send: (tabId, message) => deps.connections.request(tabId, message),
    },
    recorder: {
      inject: (tabId) => runtime.injectRecorder(tabId, true),
      stop: (tabId) => runtime.stopRecorderInTab(tabId),
    },
    /**
     * Screenshots are rate-limited and serialized; the recorder's own UI is
     * hidden while the pixels are taken. The guard runs before every attempt
     * (captureVisibleTab shoots whatever tab is in front) and once more after
     * decoding, unless the page was already told the pixels exist.
     */
    capture: (request, guard, onTaken) =>
      queueCapture(async () => {
        const check = async () => {
          assertCaptureNotCancelled(request.captureId);
          await guard();
          assertCaptureNotCancelled(request.captureId);
        };
        await check();
        const target = { tabId: request.tabId, frameIds: [0] };
        const dataUrl = await withCapturePresentation(
          {
            insert: () => browser.scripting.insertCSS({ target, css: CAPTURE_PRESENTATION_CSS, origin: 'USER' }),
            settle: async () => {
              await browser.scripting.executeScript({ target, func: waitForCapturePresentationPaint });
            },
            remove: () => browser.scripting.removeCSS({ target, css: CAPTURE_PRESENTATION_CSS, origin: 'USER' }),
          },
          () => runtime.captureVisibleTabWithRetry(request.windowId, check),
        );
        onTaken?.();
        const blob = await runtime.dataUrlToBlob(dataUrl);
        const scale = await runtime.getScreenshotScale(blob, request.viewport, request.devicePixelRatio);
        if (onTaken) assertCaptureNotCancelled(request.captureId);
        else await check();
        return { blob, scale };
      }),
    steps: {
      add: addStepsAfter,
      get: getStep,
      outlines: getStepOutlines,
      delete: deleteStep,
      deleteForRun: deleteStepsForRun,
      discardPendingAnchor,
    },
    projects: {
      get: getProject,
      ensure: async (id) => {
        await ensureProject(id);
      },
      select: setActiveProjectId,
      delete: deleteProjectPermanently,
      continuationAnchor: resolveProjectContinuationAnchor,
    },
    editor: { open: deps.openEditor },
    undo: { save: savePendingUndoRecord, read: readPendingUndoRecord, clear: clearPendingUndoRecord },
    pendingStart: { discard: discardPendingStart },
    permissions: { hasAllSites: () => browser.permissions.contains({ origins: ['<all_urls>'] }) },
    newId: () => crypto.randomUUID(),
    now: () => Date.now(),
  };
}
