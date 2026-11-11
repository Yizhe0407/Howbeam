import { vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { createRunActor } from '@/lib/recording/run/actor';
import type { RunPorts } from '@/lib/recording/run/ports';
import { createRecorderGate, type SnapshotContext } from '@/lib/recording/run/recorder-gate';
import type { Project, Step } from '@/lib/storage/models';
import type { RecordingState } from '@/lib/storage/recording-state';
import { makeRecordingState } from '../../setup/recording-state';

export const PAGE_URL = 'https://site.example/page';
export const EXTENSION_ORIGIN = 'chrome-extension://howbeam/';

export function tab(overrides: Partial<Browser.tabs.Tab> = {}): Browser.tabs.Tab {
  return { id: 4, windowId: 1, url: PAGE_URL, active: true, index: 0, pinned: false, highlighted: true, incognito: false, selected: true, discarded: false, autoDiscardable: true, groupId: -1, frozen: false, ...overrides } as Browser.tabs.Tab;
}

export function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1', title: '教學', description: '', sections: [], createdAt: 0, updatedAt: 0,
    contentRevision: 0, stepEditRevision: 0, metadataRevision: 0, stepCount: 0, entryCount: 0, storageBytes: 0,
    ...overrides,
  };
}

/** Fake browser and storage for the run flows: plain vi.fn()s with working defaults. */
export function fakePorts() {
  let id = 0;
  const steps: Step[] = [];
  const ports = {
    tabs: {
      get: vi.fn<RunPorts['tabs']['get']>(async (tabId) => tab({ id: tabId })),
      activeInCurrentWindow: vi.fn<RunPorts['tabs']['activeInCurrentWindow']>(async () => tab()),
      activeInWindow: vi.fn<RunPorts['tabs']['activeInWindow']>(async () => tab()),
      focus: vi.fn<RunPorts['tabs']['focus']>(async () => {}),
      send: vi.fn<RunPorts['tabs']['send']>(async () => true),
    },
    recorder: {
      inject: vi.fn<RunPorts['recorder']['inject']>(async () => {}),
      stop: vi.fn<RunPorts['recorder']['stop']>(async () => {}),
    },
    capture: vi.fn<RunPorts['capture']>(async (_request, guard, onTaken) => {
      await guard();
      onTaken?.();
      return { blob: new Blob(['png'], { type: 'image/png' }), scale: 1 };
    }),
    steps: {
      add: vi.fn(async (added: readonly Step[]) => {
        steps.push(...added.map((step) => ({ ...step, order: steps.length })));
      }),
      get: vi.fn(async (stepId: string) => steps.find((step) => step.id === stepId)),
      outlines: vi.fn(async (sessionId: string) => steps.filter((step) => step.sessionId === sessionId)),
      delete: vi.fn(async (stepId: string) => {
        const index = steps.findIndex((step) => step.id === stepId);
        if (index !== -1) steps.splice(index, 1);
      }),
      deleteForRun: vi.fn(async (_sessionId: string, runId: string) => {
        for (let index = steps.length - 1; index >= 0; index -= 1) if (steps[index]!.runId === runId) steps.splice(index, 1);
      }),
      discardPendingAnchor: vi.fn<RunPorts['steps']['discardPendingAnchor']>(async () => false),
    },
    projects: {
      get: vi.fn<RunPorts['projects']['get']>(async (projectId) => project({ id: projectId })),
      discardIfPristine: vi.fn<RunPorts['projects']['discardIfPristine']>(async () => true),
      continuationAnchor: vi.fn<RunPorts['projects']['continuationAnchor']>(async () => null),
    },
    editor: { open: vi.fn<RunPorts['editor']['open']>(async () => ({ ok: true })) },
    undo: {
      save: vi.fn<RunPorts['undo']['save']>(async () => {}),
      read: vi.fn<RunPorts['undo']['read']>(async () => null),
      clear: vi.fn<RunPorts['undo']['clear']>(async () => {}),
    },
    permissions: { hasAllSites: vi.fn<RunPorts['permissions']['hasAllSites']>(async () => true) },
    newId: vi.fn(() => `id-${++id}`),
    now: vi.fn(() => 1_000),
  } satisfies RunPorts;
  return { ports, steps };
}

export function fakeActor(stored: RecordingState = makeRecordingState()) {
  const saved: RecordingState[] = [];
  const actor = createRunActor({ load: async () => stored, save: async (state) => { saved.push(state); } });
  return { actor, saved, gate: createRecorderGate(50) };
}

/** Lets queued microtasks and immediately-due timers run. */
export async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Lifecycle, capture and undo wired together as the background wires them. */
export async function wiredRun(stored: RecordingState = makeRecordingState()) {
  const { createLifecycle } = await import('@/lib/recording/run/lifecycle');
  const { createCapture } = await import('@/lib/recording/run/capture');
  const { createUndo } = await import('@/lib/recording/run/undo');
  const { toRecordingState } = await import('@/lib/recording/run/state');
  const { ports, steps } = fakePorts();
  const { actor, saved, gate } = fakeActor(stored);
  const undo = createUndo({ actor, ports });
  // eslint-disable-next-line prefer-const -- capture and lifecycle need each other
  let capture: ReturnType<typeof createCapture>;
  const lifecycle = createLifecycle({
    actor,
    ports,
    gate,
    extensionOrigin: EXTENSION_ORIGIN,
    captureAnchor: (...args) => capture.captureAnchor(...args),
    discardUndo: undo.discard,
    isRecaptureStarting: () => false,
    resolveContinuationTab: async () => ({ ok: false, error: 'background.continuationSourceMissing' }),
    continueAfterTabClosed: async () => 'nowhere',
  });
  capture = createCapture({ actor, ports, gate, lifecycle, discardUndo: undo.discard });
  const { createSnapshotControls } = await import('@/lib/recording/run/snapshot');
  const snapshot = createSnapshotControls({ actor, ports, lifecycle, capture, discardUndo: undo.discard });
  await actor.ready();
  /** Every injection reports ready (with this snapshot context), as a content script would. */
  function recorderReports(snapshotContext?: SnapshotContext): void {
    ports.recorder.inject.mockImplementation(async (tabId) => {
      queueMicrotask(() => {
        const op = actor.state().operation;
        if (op.kind === 'recording') gate.signal(op.runId, tabId, snapshotContext ? { snapshotContext } : {});
      });
    });
  }
  return { lifecycle, capture, undo, snapshot, recorderReports, ports, steps, actor, saved, gate, state: () => toRecordingState(actor.state()) };
}
