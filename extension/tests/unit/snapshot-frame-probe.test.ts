// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'test-extension',
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  },
}));

import { installSnapshotFrameProbe, resolveSnapshotTargetAtPoint } from '@/lib/recording/snapshot-targeting';
import { CLEANUP_EVENT } from '@/lib/recording/content-script-constants';

/**
 * A snapshot click that lands on an iframe asks the child frame for its target
 * over a MessageChannel. jsdom has no layout and no cross-frame messaging, so
 * the iframe's box is given and the test answers in place of the child frame.
 */

const CHILD_ORIGIN = 'https://child.example';

interface ProbeRequest {
  data: { type: string; runId: string; clientX: number; clientY: number; timeoutMs: number };
  origin: string;
  port: MessagePort;
}

/** An iframe at (100, 50) with a 2px border; its window records every probe. */
function placeIframe(): { frame: HTMLIFrameElement; requests: ProbeRequest[]; postMessage: ReturnType<typeof vi.fn> } {
  const frame = document.createElement('iframe');
  frame.src = `${CHILD_ORIGIN}/page`;
  document.body.appendChild(frame);
  const rect = DOMRect.fromRect({ x: 100, y: 50, width: 304, height: 204 });
  frame.getBoundingClientRect = () => rect;
  frame.getClientRects = () => [rect] as unknown as DOMRectList;
  Object.defineProperties(frame, {
    offsetWidth: { value: 304 },
    offsetHeight: { value: 204 },
    clientLeft: { value: 2 },
    clientTop: { value: 2 },
  });
  const requests: ProbeRequest[] = [];
  const postMessage = vi.fn((data: ProbeRequest['data'], origin: string, transfer: MessagePort[]) => {
    requests.push({ data, origin, port: transfer[0] });
  });
  Object.defineProperty(frame, 'contentWindow', { value: { postMessage } });
  document.elementFromPoint = () => frame;
  return { frame, requests, postMessage };
}

/** Waits for the probe to be posted, then answers it as the child frame would. */
async function answer(requests: ProbeRequest[], response: unknown): Promise<void> {
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  requests[0].port.postMessage(response);
}

let runId: string;

beforeEach(() => {
  runId = crypto.randomUUID();
  vi.stubGlobal('innerWidth', 1280);
  vi.stubGlobal('innerHeight', 720);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('a snapshot click on an iframe', () => {
  it('asks the child frame at the point inside it, addressed to the child’s origin only', async () => {
    const { requests } = placeIframe();

    const resolving = resolveSnapshotTargetAtPoint(runId, 152, 92, 120);
    await answer(requests, null);
    await resolving;

    expect(requests[0].origin).toBe(CHILD_ORIGIN);
    expect(requests[0].data).toMatchObject({ runId, clientX: 50, clientY: 40, timeoutMs: 100 });
  });

  it('maps the child’s target into this viewport, clipped to the frame’s visible box', async () => {
    const { requests } = placeIframe();

    const resolving = resolveSnapshotTargetAtPoint(runId, 152, 92, 120);
    await answer(requests, {
      rect: { x: 280, y: 10, width: 60, height: 20 },
      identity: 'button#save',
      text: 'Save',
      tagName: 'button',
    });

    expect(await resolving).toMatchObject({
      rect: { x: 382, y: 62, width: 22, height: 20 },
      identity: expect.stringMatching(/::frame::button#save$/),
      text: 'Save',
      tagName: 'button',
    });
  });

  it('answers nothing when the child found nothing there', async () => {
    const { requests } = placeIframe();

    const resolving = resolveSnapshotTargetAtPoint(runId, 152, 92, 120);
    await answer(requests, null);

    expect(await resolving).toBeNull();
  });

  it('selects the frame itself when the child cannot answer, and stops asking it for a while', async () => {
    const { frame, requests, postMessage } = placeIframe();

    const first = resolveSnapshotTargetAtPoint(runId, 152, 92, 120);
    await answer(requests, { fallback: true });
    expect(await first).toMatchObject({ element: frame, rect: { x: 100, y: 50, width: 304, height: 204 } });

    await expect(resolveSnapshotTargetAtPoint(runId, 152, 92, 120)).resolves.toMatchObject({ element: frame });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('selects the frame itself when the child never answers', async () => {
    const { frame } = placeIframe();

    await expect(resolveSnapshotTargetAtPoint(runId, 152, 92, 5)).resolves.toMatchObject({ element: frame });
  });

  it('never posts into a sandboxed frame it cannot address', async () => {
    const { frame, postMessage } = placeIframe();
    frame.setAttribute('sandbox', '');
    // jsdom has no iframe.sandbox token list; this one holds no allow-same-origin.
    Object.defineProperty(frame, 'sandbox', { value: { contains: () => false } });

    await expect(resolveSnapshotTargetAtPoint(runId, 152, 92, 120)).resolves.toMatchObject({ element: frame });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('ignores a malformed answer', async () => {
    const { requests } = placeIframe();

    const resolving = resolveSnapshotTargetAtPoint(runId, 152, 92, 120);
    await answer(requests, { rect: { x: 0, y: 0, width: 10, height: 10 }, identity: '', text: '', tagName: 'b' });

    expect(await resolving).toBeNull();
  });
});

describe('the child frame’s probe responder', () => {
  function probe(port: MessagePort, overrides: Record<string, unknown> = {}) {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'howbeam_snapshot_probe_test-extension', runId, timeoutMs: 100, clientX: 20, clientY: 30, ...overrides },
      source: window.parent,
      ports: [port],
    }));
  }

  it('answers the parent with the target at the asked point', async () => {
    const button = document.createElement('button');
    button.setAttribute('aria-label', 'Save');
    document.body.appendChild(button);
    const rect = DOMRect.fromRect({ x: 10, y: 20, width: 60, height: 24 });
    button.getBoundingClientRect = () => rect;
    button.getClientRects = () => [rect] as unknown as DOMRectList;
    document.elementFromPoint = () => button;
    installSnapshotFrameProbe(runId);
    const channel = new MessageChannel();
    const answered = new Promise<unknown>((resolve) => {
      channel.port1.onmessage = (event) => resolve(event.data);
    });

    probe(channel.port2);

    expect(await answered).toMatchObject({ rect: { x: 10, y: 20, width: 60, height: 24 }, text: 'Save', tagName: 'button' });
    document.dispatchEvent(new Event(CLEANUP_EVENT));
    channel.port1.close();
  });

  it('closes the port of a probe for another run without answering', async () => {
    installSnapshotFrameProbe(runId);
    const channel = new MessageChannel();
    const onAnswer = vi.fn();
    channel.port1.onmessage = onAnswer;
    const closed = new Promise<void>((resolve) => channel.port1.addEventListener('close', () => resolve()));

    probe(channel.port2, { runId: 'other-run' });

    await closed;
    expect(onAnswer).not.toHaveBeenCalled();
    document.dispatchEvent(new Event(CLEANUP_EVENT));
  });
});
