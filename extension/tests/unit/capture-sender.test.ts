import { beforeEach, describe, expect, it, vi } from 'vitest';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  getRecordingState: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: { runtime: { sendMessage: mocks.sendMessage } },
}));
vi.mock('@/lib/storage/storage', () => ({
  getRecordingState: mocks.getRecordingState,
}));

const { createCaptureSender } = await import('@/lib/recording/content/capture-sender');

const rect = { x: 1, y: 2, width: 3, height: 4 };
const deliver = () =>
  createCaptureSender('run-1').deliverStepCapture(rect, { text: 'Save', tagName: 'button' }, 'click', 1, 'capture-1');

beforeEach(() => {
  mocks.sendMessage.mockReset();
  mocks.getRecordingState.mockReset();
  mocks.getRecordingState.mockResolvedValue({ operation: 'recording', runId: 'run-1', lastCommittedCaptureId: 'capture-0' });
  vi.stubGlobal('window', { devicePixelRatio: 1, innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0 });
  vi.stubGlobal('location', { href: 'https://example.test/' });
});

describe('deliverStepCapture', () => {
  it('reports the screenshot as taken while the step is still being stored', async () => {
    let answer!: (result: unknown) => void;
    mocks.sendMessage.mockReturnValue(new Promise((resolve) => {
      answer = resolve;
    }));
    const sender = createCaptureSender('run-1');
    const onTaken = vi.fn();
    const delivery = sender.deliverStepCapture(rect, { text: 'Save', tagName: 'button' }, 'click', 1, 'capture-1', 'element', onTaken);

    sender.markCaptureTaken('capture-2');
    expect(onTaken).not.toHaveBeenCalled();
    sender.markCaptureTaken('capture-1');
    expect(onTaken).toHaveBeenCalledOnce();

    answer({ ok: true });
    await expect(delivery).resolves.toBe('saved');
    sender.markCaptureTaken('capture-1');
    expect(onTaken).toHaveBeenCalledOnce();
  });

  it('reports a stored step as saved', async () => {
    mocks.sendMessage.mockResolvedValue({ ok: true });
    await expect(deliver()).resolves.toBe('saved');
  });

  it('sends the capture without reading the recording state first', async () => {
    mocks.sendMessage.mockResolvedValue({ ok: true });
    await deliver();
    expect(mocks.getRecordingState).not.toHaveBeenCalled();
  });

  it('reports a rejection the background already told the user about as rejected', async () => {
    silenceIntentionalErrorLogs();
    mocks.sendMessage.mockResolvedValue({ ok: false, error: 'capture-failed', reported: true });
    await expect(deliver()).resolves.toBe('rejected');
  });

  it('reports a rejection nobody explained as lost', async () => {
    silenceIntentionalErrorLogs();
    mocks.sendMessage.mockResolvedValue({ ok: false, error: 'not-accepting-clicks' });
    await expect(deliver()).resolves.toBe('lost');
  });

  it('reports a click as lost when the worker died mid-request and no step landed', async () => {
    silenceIntentionalErrorLogs();
    mocks.sendMessage.mockRejectedValue(new Error('The message port closed before a response was received.'));
    await expect(deliver()).resolves.toBe('lost');
  });

  it('treats a crashed handler like a lost answer', async () => {
    silenceIntentionalErrorLogs();
    mocks.sendMessage.mockResolvedValue({ ok: false, error: 'capture-request-failed' });
    await expect(deliver()).resolves.toBe('lost');
  });

  it('reconciles a lost answer against the durably committed capture id', async () => {
    silenceIntentionalErrorLogs();
    mocks.getRecordingState.mockResolvedValue({ operation: 'recording', runId: 'run-1', lastCommittedCaptureId: 'capture-1' });
    mocks.sendMessage.mockResolvedValue(undefined);
    await expect(deliver()).resolves.toBe('saved');
  });
});
