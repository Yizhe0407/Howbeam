import { describe, expect, it } from 'vitest';
import {
  isBackgroundMessage,
  isExtensionPageOnlyMessage,
  isTrustedExtensionPageSender,
  isTrustedKeepAliveSender,
  isTrustedRecorderControlSender,
} from '@/lib/runtime/background-message-validation';
import type { BackgroundMessage } from '@/lib/runtime/messages';

const validClick = {
  type: 'HOWBEAM_CLICK',
  captureId: 'capture-1',
  runId: 'run-1',
  rect: { x: 10.5, y: -2, width: 40, height: 20 },
  viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 100 },
  devicePixelRatio: 2,
  text: 'Settings',
  tagName: 'BUTTON',
  intent: 'click',
  url: 'https://example.com/page',
  timestamp: 123,
} as const;

const validStepFrameBegin = {
  type: 'HOWBEAM_STEP_FRAME_BEGIN',
  runId: 'run-1',
  captureId: 'capture-1',
  rect: { x: -10.5, y: 20, width: 120.25, height: 48 },
  text: 'Open settings',
  tagName: 'BUTTON',
  interactive: true,
} as const;

const validStepFrameClaim = {
  type: 'HOWBEAM_STEP_FRAME_CLAIM',
  runId: 'run-1',
  captureId: 'capture-1',
  relayToken: 'relay-token',
} as const;

const validStepFrameReject = {
  type: 'HOWBEAM_STEP_FRAME_REJECT',
  runId: 'run-1',
  captureId: 'capture-1',
  relayToken: 'relay-token',
} as const;

const validStepFrameSettle = {
  type: 'HOWBEAM_STEP_FRAME_SETTLE',
  runId: 'run-1',
  captureId: 'capture-1',
  settleToken: 'settle-token',
  replay: true,
} as const;

const validStepFrameAbort = {
  type: 'HOWBEAM_STEP_FRAME_ABORT',
  runId: 'run-1',
  captureId: 'capture-1',
} as const;

describe('recording mode switch controls', () => {
  it.each([
    'SWITCH_TO_SNAPSHOT_MODE',
    'SWITCH_TO_STEPS_MODE',
  ])('accepts %s only with a run id', (type) => {
    expect(isBackgroundMessage({ type, runId: 'run-1' })).toBe(true);
    expect(isBackgroundMessage({ type })).toBe(false);
  });
});

describe('background runtime message validation', () => {
  it.each<unknown>([
    validClick,
    { type: 'START_RECORDING', sessionId: 'project-1', mode: 'steps' },
    { type: 'OPEN_EDITOR', sessionId: 'project-1', entryId: 'step-1' },
    { type: 'PAUSE_RECORDING', runId: 'run-1' },
    {
      type: 'HOWBEAM_READY',
      runId: 'run-1',
      snapshotContext: {
        viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0 },
        devicePixelRatio: 1,
        url: 'https://example.com/',
        timestamp: 456,
      },
    },
    { type: 'SNAPSHOT_RECORDER_FAILED', runId: 'run-1', reason: 'shield-channel' },
    {
      type: 'START_STEP_RECAPTURE',
      sessionId: 'project-1',
      target: { kind: 'snapshot-singleton', anchorId: 'anchor-1', annotationId: 'annotation-1' },
      preferredTabId: 7,
    },
    { type: 'START_RECORDING', sessionId: 'project-1', mode: 'steps', continuation: {} },
    { type: 'START_RECORDING', sessionId: 'project-1', mode: 'steps', continuation: { preferredTabId: 4 } },
    { type: 'START_RECORDING', sessionId: 'project-1', mode: 'steps', autoCreatedProject: true },
    { type: 'START_RECORDING', sessionId: 'project-1', mode: 'snapshot', autoCreatedProject: false },
    { type: 'PREFLIGHT_PROJECT_CONTINUATION_SOURCE_PERMISSION', sessionId: 'project-1' },
    { type: 'OPEN_LIBRARY' },
    { type: 'REGISTER_EXTENSION_PAGE' },
  ])('accepts a structurally valid message %#', (message) => {
    expect(isBackgroundMessage(message)).toBe(true);
  });

  it.each<unknown>([
    null,
    [],
    {},
    { type: 'UNKNOWN' },
    { ...validClick, rect: { ...validClick.rect, width: 0 } },
    { ...validClick, rect: { ...validClick.rect, x: Number.NaN } },
    { ...validClick, viewport: { ...validClick.viewport, height: -1 } },
    { ...validClick, devicePixelRatio: 0 },
    { ...validClick, devicePixelRatio: 33 },
    { ...validClick, text: 'x'.repeat(10_001) },
    { ...validClick, url: 'javascript:alert(1)' },
    { ...validClick, url: 'https://user:secret@example.com/' },
    { ...validClick, timestamp: 1.5 },
    { type: 'START_RECORDING', sessionId: '', mode: 'steps' },
    { type: 'OPEN_EDITOR', sessionId: 'x'.repeat(257) },
    { type: 'SNAPSHOT_RECORDER_FAILED', runId: 'run-1', reason: 'other' },
    { type: 'SNAPSHOT_RECORDER_FAILED', runId: '', reason: 'shield-channel' },
    {
      type: 'START_STEP_RECAPTURE',
      sessionId: 'project-1',
      target: { kind: 'single', stepId: 'step-1' },
      preferredTabId: -1,
    },
    {
      type: 'START_STEP_RECAPTURE',
      sessionId: 'project-1',
      target: { kind: 'snapshot-singleton', anchorId: 'same', annotationId: 'same' },
    },
    { type: 'START_RECORDING', sessionId: 'project-1', mode: 'steps', continuation: { preferredTabId: -1 } },
    { type: 'START_RECORDING', sessionId: 'project-1', mode: 'steps', continuation: null },
    { type: 'START_RECORDING', sessionId: 'project-1', mode: 'steps', autoCreatedProject: 'yes' },
    // A caller-supplied source URL must never reach the permission prompt.
    { type: 'START_RECORDING', sessionId: 'project-1', mode: 'steps', continuation: { sourceUrl: 'https://attacker.example/' } },
    { type: 'PREFLIGHT_PROJECT_CONTINUATION_SOURCE_PERMISSION', sessionId: '' },
  ])('rejects malformed or resource-unbounded input %#', (message) => {
    expect(isBackgroundMessage(message)).toBe(false);
  });
});

describe('step frame relay runtime payload validation', () => {
  it.each<unknown>([
    validStepFrameBegin,
    validStepFrameClaim,
    validStepFrameReject,
    validStepFrameSettle,
    { ...validStepFrameSettle, replay: false },
    validStepFrameAbort,
  ])('accepts a valid relay message %#', (message) => {
    expect(isBackgroundMessage(message)).toBe(true);
  });

  it.each<{ name: string; message: unknown }>([
    {
      name: 'begin with an empty run id',
      message: { ...validStepFrameBegin, runId: '' },
    },
    {
      name: 'begin with an overlong capture id',
      message: { ...validStepFrameBegin, captureId: 'x'.repeat(257) },
    },
    {
      name: 'begin with a zero-width rect',
      message: { ...validStepFrameBegin, rect: { ...validStepFrameBegin.rect, width: 0 } },
    },
    {
      name: 'begin with non-finite geometry',
      message: { ...validStepFrameBegin, rect: { ...validStepFrameBegin.rect, x: Number.NaN } },
    },
    {
      name: 'begin with out-of-range geometry',
      message: { ...validStepFrameBegin, rect: { ...validStepFrameBegin.rect, x: 10_000_001 } },
    },
    {
      name: 'begin with overlong text',
      message: { ...validStepFrameBegin, text: 'x'.repeat(201) },
    },
    {
      name: 'begin with non-string text',
      message: { ...validStepFrameBegin, text: 42 },
    },
    {
      name: 'begin with an empty tag name',
      message: { ...validStepFrameBegin, tagName: '' },
    },
    {
      name: 'begin with an overlong tag name',
      message: { ...validStepFrameBegin, tagName: 'T'.repeat(101) },
    },
    {
      name: 'begin with a non-boolean interactive flag',
      message: { ...validStepFrameBegin, interactive: 'yes' },
    },
    {
      name: 'claim with an empty run id',
      message: { ...validStepFrameClaim, runId: '' },
    },
    {
      name: 'claim with an empty capture id',
      message: { ...validStepFrameClaim, captureId: '' },
    },
    {
      name: 'claim with a missing relay token',
      message: {
        type: validStepFrameClaim.type,
        runId: validStepFrameClaim.runId,
        captureId: validStepFrameClaim.captureId,
      },
    },
    {
      name: 'claim with an overlong relay token',
      message: { ...validStepFrameClaim, relayToken: 'x'.repeat(257) },
    },
    {
      name: 'reject with an overlong run id',
      message: { ...validStepFrameReject, runId: 'x'.repeat(257) },
    },
    {
      name: 'reject with a non-string capture id',
      message: { ...validStepFrameReject, captureId: 42 },
    },
    {
      name: 'reject with an empty relay token',
      message: { ...validStepFrameReject, relayToken: '' },
    },
    {
      name: 'settle with an empty run id',
      message: { ...validStepFrameSettle, runId: '' },
    },
    {
      name: 'settle with an overlong capture id',
      message: { ...validStepFrameSettle, captureId: 'x'.repeat(257) },
    },
    {
      name: 'settle with an empty settle token',
      message: { ...validStepFrameSettle, settleToken: '' },
    },
    {
      name: 'settle with only the page-visible relay token',
      message: {
        type: validStepFrameSettle.type,
        runId: validStepFrameSettle.runId,
        captureId: validStepFrameSettle.captureId,
        relayToken: validStepFrameClaim.relayToken,
        replay: true,
      },
    },
    {
      name: 'settle with a non-boolean replay flag',
      message: { ...validStepFrameSettle, replay: 'true' },
    },
    {
      name: 'abort with an empty run id',
      message: { ...validStepFrameAbort, runId: '' },
    },
    {
      name: 'abort with an overlong capture id',
      message: { ...validStepFrameAbort, captureId: 'x'.repeat(257) },
    },
    {
      name: 'abort without a capture id',
      message: {
        type: validStepFrameAbort.type,
        runId: validStepFrameAbort.runId,
      },
    },
    {
      name: 'background-to-origin result sent in the inbound background channel',
      message: {
        type: 'HOWBEAM_STEP_FRAME_RESULT',
        runId: 'run-1',
        captureId: 'capture-1',
        replay: true,
      },
    },
  ])('rejects $name', ({ message }) => {
    expect(isBackgroundMessage(message)).toBe(false);
  });
});

describe('background sender authorization', () => {
  const extensionRoot = 'chrome-extension://howbeam-id/';

  it('accepts popup and top-level pages owned by this extension', () => {
    expect(isTrustedExtensionPageSender(
      { url: 'chrome-extension://howbeam-id/popup.html' },
      extensionRoot,
    )).toBe(true);
    expect(isTrustedExtensionPageSender(
      {
        frameId: 0,
        url: 'chrome-extension://howbeam-id/editor.html?session=1',
        tab: { id: 9, url: 'chrome-extension://howbeam-id/editor.html?session=1' },
      },
      extensionRoot,
    )).toBe(true);
  });

  it.each([
    { url: 'https://example.com/', tab: { id: 1, url: 'https://example.com/' }, frameId: 0 },
    {
      url: 'chrome-extension://howbeam-id/editor.html',
      tab: { id: 1, url: 'chrome-extension://howbeam-id/editor.html' },
      frameId: 2,
    },
    {
      url: 'chrome-extension://howbeam-id/editor.html',
      tab: { id: 1, url: 'https://example.com/' },
      frameId: 0,
    },
    { url: 'chrome-extension://different-extension/popup.html' },
    { url: 'moz-extension://howbeam-id/popup.html' },
  ])('rejects content, child-frame, mixed-origin, and foreign-extension senders %#', (sender) => {
    expect(isTrustedExtensionPageSender(sender, extensionRoot)).toBe(false);
  });

  it('classifies lifecycle, toolbar controls, and recorder events separately', () => {
    const extensionOnly: BackgroundMessage[] = [
      { type: 'START_RECORDING', sessionId: 'project-1', mode: 'steps' },
      { type: 'STOP_RECORDING' },
      { type: 'RESET_PROJECT', sessionId: 'project-1' },
      { type: 'OPEN_EDITOR' },
      { type: 'OPEN_LIBRARY' },
      { type: 'REGISTER_EXTENSION_PAGE' },
    ];
    const recordingControls: BackgroundMessage[] = [
      { type: 'PAUSE_RECORDING', runId: 'run-1' },
      { type: 'DISCARD_CURRENT_RECORDING', runId: 'run-1' },
    ];
    const recorderMessages: BackgroundMessage[] = [
      validClick,
      { type: 'HOWBEAM_CANCEL_CAPTURE', runId: 'run-1', captureId: 'capture-1' },
      { type: 'HOWBEAM_READY', runId: 'run-1' },
      { type: 'SNAPSHOT_RECORDER_FAILED', runId: 'run-1', reason: 'shield-channel' },
    ];

    expect(extensionOnly.every(isExtensionPageOnlyMessage)).toBe(true);
    expect(recordingControls.some(isExtensionPageOnlyMessage)).toBe(false);
    expect(recorderMessages.some(isExtensionPageOnlyMessage)).toBe(false);
  });

  it('authorizes keep-alive ports only for the top frame owning the active job', () => {
    const sender = { frameId: 0, tab: { id: 7, url: 'https://example.com/' } };
    expect(isTrustedKeepAliveSender(sender, {
      operation: 'recording', isRecording: true, tabId: 7, recapture: null,
    })).toBe(true);
    expect(isTrustedKeepAliveSender(sender, {
      operation: 'recapture', isRecording: false, tabId: null,
      recapture: { sourceTabId: 7 },
    })).toBe(true);
    expect(isTrustedKeepAliveSender({ ...sender, frameId: 2 }, {
      operation: 'recording', isRecording: true, tabId: 7, recapture: null,
    })).toBe(false);
    expect(isTrustedKeepAliveSender(sender, {
      operation: null, isRecording: false, tabId: null, recapture: null,
    })).toBe(false);
  });

  it('keeps trusting the tab a recording is moving out of until the move settles', () => {
    const sender = { frameId: 0, tab: { id: 4, url: 'https://example.com/' } };
    const moving = { operation: 'recording', isRecording: true, tabId: 9, recapture: null } as const;
    expect(isTrustedKeepAliveSender(sender, moving)).toBe(false);
    expect(isTrustedKeepAliveSender(sender, moving, 4)).toBe(true);
    expect(isTrustedKeepAliveSender(sender, { ...moving, isRecording: false }, 4)).toBe(false);
  });

  it('accepts recording controls only from the top frame of the recorded tab', () => {
    expect(isTrustedRecorderControlSender(
      { frameId: 0, url: 'https://example.com/', tab: { id: 7, url: 'https://example.com/' } },
      7,
    )).toBe(true);

    expect(isTrustedRecorderControlSender(
      { frameId: 1, url: 'https://example.com/frame', tab: { id: 7, url: 'https://example.com/' } },
      7,
    )).toBe(false);
    expect(isTrustedRecorderControlSender(
      { frameId: 0, url: 'https://example.com/', tab: { id: 8, url: 'https://example.com/' } },
      7,
    )).toBe(false);
    expect(isTrustedRecorderControlSender(
      { frameId: 0, url: 'https://example.com/', tab: { id: 7, url: 'https://example.com/' } },
      null,
    )).toBe(false);
  });
});
