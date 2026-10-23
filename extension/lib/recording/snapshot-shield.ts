import { browser } from 'wxt/browser';
import {
  buildShieldTokenStorageKey,
  isSnapshotShieldPortMessage,
  SNAPSHOT_SHIELD_CANDIDATES,
  SNAPSHOT_SHIELD_CAPTURE_COMPLETE,
  SNAPSHOT_SHIELD_COMMIT,
  SNAPSHOT_SHIELD_CONTROL,
  SNAPSHOT_SHIELD_CONTROL_RESULT,
  SNAPSHOT_SHIELD_INIT,
  SNAPSHOT_SHIELD_POINTER_DOWN,
  SNAPSHOT_SHIELD_POINTER_MOVE,
  SNAPSHOT_SHIELD_PREVIEW,
  SNAPSHOT_SHIELD_READY,
  SNAPSHOT_SHIELD_REGION_CAPTURE,
  SNAPSHOT_SHIELD_TOKEN_STORAGE_PREFIX,
  SNAPSHOT_SHIELD_TOKEN_TTL_MS,
  SNAPSHOT_SHIELD_TOOLBAR_STATE,
  SNAPSHOT_SHIELD_UNDO,
  type SnapshotShieldControlMessage,
  type SnapshotShieldFrameMessage,
  type SnapshotShieldInitMessage,
  type ToolbarTheme,
  type SnapshotShieldPointerDownMessage,
  type SnapshotShieldPointerMoveMessage,
  type SnapshotShieldRegionCaptureMessage,
  type SnapshotShieldKeyboardAnchor,
  type SnapshotShieldPreviewResult,
  type SnapshotShieldSelection,
  type SnapshotShieldTokenRecord,
  type SnapshotShieldToolbarStateMessage,
  type WithoutToken,
} from './snapshot-shield-protocol';
import { deepElementFromPoint } from '../capture/selector/element-availability';
import { createViewportOverlayHost, setImportantStyle } from '../capture/viewport-overlay-host';
import { REAPPEAR_TRANSITION } from '../capture/capture-presentation';
import type { RecordingControlResult } from '../runtime/messages';
import { t } from '@/lib/shared/i18n';

const SHIELD_PAGE = '/snapshot-shield.html';
const SHIELD_READY_TIMEOUT_MS = 4_000;
const SHIELD_BACKDROP_CSS = `
  :host::backdrop {
    background: transparent !important;
    -webkit-backdrop-filter: none !important;
    backdrop-filter: none !important;
    filter: none !important;
    animation: none !important;
    transition: none !important;
    pointer-events: none !important;
  }
`;

export interface SnapshotShield {
  ready: Promise<void>;
  runWithoutShield<T>(callback: () => T): T;
  updateToolbar(state: SnapshotShieldToolbarStateMessage['state']): void;
  sendKeyboardCandidates(anchors: SnapshotShieldKeyboardAnchor[]): void;
  remove(): void;
}

type PointHandler = (
  point: SnapshotShieldPointerDownMessage,
) => SnapshotShieldSelection | null | void | Promise<SnapshotShieldSelection | null | void>;
type HoverHandler = (
  point: SnapshotShieldPointerMoveMessage,
) => SnapshotShieldPreviewResult | Promise<SnapshotShieldPreviewResult>;
type ControlHandler = (message: SnapshotShieldControlMessage) => Promise<RecordingControlResult>;
type RegionHandler = (
  message: SnapshotShieldRegionCaptureMessage,
) => SnapshotShieldSelection | null | void | Promise<SnapshotShieldSelection | null | void>;
type FailureHandler = (error: Error) => void | Promise<void>;

function isDialogElement(value: unknown): value is HTMLDialogElement {
  return typeof HTMLDialogElement !== 'undefined' && value instanceof HTMLDialogElement;
}

function isModalDialog(element: Element): element is HTMLDialogElement {
  if (!isDialogElement(element)) return false;
  try {
    return element.matches(':modal');
  } catch {
    return element.open;
  }
}

function findModalAncestor(element: Element | null): HTMLDialogElement | null {
  let current = element;
  while (current) {
    if (isModalDialog(current)) return current;
    if (current.parentElement) {
      current = current.parentElement;
      continue;
    }
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

function getDeepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

function installBackdropStyles(shadowRoot: ShadowRoot): void {
  try {
    if (
      typeof CSSStyleSheet !== 'undefined' &&
      typeof CSSStyleSheet.prototype.replaceSync === 'function' &&
      'adoptedStyleSheets' in shadowRoot
    ) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(SHIELD_BACKDROP_CSS);
      shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, sheet];
      return;
    }
  } catch {
    // Fall through for browsers without constructable stylesheet support.
  }
  const style = document.createElement('style');
  style.textContent = SHIELD_BACKDROP_CSS;
  shadowRoot.append(style);
}

function hardenFrame(frame: HTMLIFrameElement): void {
  const declarations: Record<string, string> = {
    all: 'initial',
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    margin: '0',
    padding: '0',
    border: '0',
    display: 'block',
    'box-sizing': 'border-box',
    opacity: '1',
    visibility: 'visible',
    background: 'transparent',
    // Keep the iframe element's used scheme identical to the shield
    // document root. Chromium paints a nominally transparent iframe canvas
    // opaque when these schemes differ (commonly a white sheet on dark-mode
    // pages). The shield owns all themed controls, so an only-light canvas
    // scheme is safe as long as both sides explicitly agree. `only` also
    // prevents a forced browser preference from overriding just one context.
    'color-scheme': 'only light',
    'pointer-events': 'auto',
  };
  for (const [property, value] of Object.entries(declarations)) setImportantStyle(frame, property, value);
}

/** Removes shield token records orphaned by a crashed creator (best effort).
 * The active shield's own record is never touched. */
async function sweepStaleShieldTokens(activeKey: string): Promise<void> {
  const all = await browser.storage.local.get(null);
  const cutoff = Date.now() - SNAPSHOT_SHIELD_TOKEN_TTL_MS;
  const stale = Object.entries(all)
    .filter(([key, value]) => {
      if (!key.startsWith(SNAPSHOT_SHIELD_TOKEN_STORAGE_PREFIX) || key === activeKey) return false;
      const createdAt = (value as { createdAt?: unknown } | null)?.createdAt;
      return typeof createdAt !== 'number' || createdAt <= cutoff;
    })
    .map(([key]) => key);
  if (stale.length > 0) await browser.storage.local.remove(stale);
}

/**
 * Mounts an extension-origin browsing context over the page. Pointer events
 * terminate inside the iframe instead of traversing the host page's window,
 * document, or target listeners.
 */
export function createSnapshotShield(
  onPoint: PointHandler,
  onHover?: HoverHandler,
  onControl?: ControlHandler,
  onRegion?: RegionHandler,
  onFailure?: FailureHandler,
): SnapshotShield {
  const token = crypto.randomUUID();
  // Public identifier only. The secret token is parked in extension storage
  // under this key so the host page can never recover it from the frame URL
  // (resource timing exposes URLs) and race the init handshake.
  const frameKey = crypto.randomUUID();
  const tokenStorageKey = buildShieldTokenStorageKey(frameKey);
  const host = createViewportOverlayHost(
    'data-howbeam-snapshot-shield',
    {
      'min-width': '0',
      'min-height': '0',
      'max-width': 'none',
      'max-height': 'none',
      'box-sizing': 'border-box',
      opacity: '1',
      visibility: 'visible',
      overflow: 'hidden',
      contain: 'strict',
      transform: 'none',
      filter: 'none',
      'backdrop-filter': 'none',
      animation: 'none',
      transition: REAPPEAR_TRANSITION,
      'pointer-events': 'auto',
    },
    { popover: true },
  );

  const shadowRoot = host.attachShadow({ mode: 'closed' });
  installBackdropStyles(shadowRoot);
  const frame = document.createElement('iframe');
  frame.title = 'Howbeam snapshot input shield';
  frame.tabIndex = -1;
  frame.referrerPolicy = 'no-referrer';
  hardenFrame(frame);

  const frameUrl = new URL(browser.runtime.getURL(SHIELD_PAGE));
  frameUrl.searchParams.set('frame', frameKey);
  shadowRoot.append(frame);

  let removed = false;
  let ready = false;
  let channelGeneration = 0;
  let nextSelectionId = 1;
  const committedSelections: Array<SnapshotShieldSelection & { id: number }> = [];
  let lastUndoneSelection: (SnapshotShieldSelection & { id: number }) | null = null;
  let toolbarState: SnapshotShieldToolbarStateMessage['state'] | null = null;
  let keyboardAnchors: SnapshotShieldKeyboardAnchor[] | null = null;
  let port: MessagePort | null = null;
  let resolveReady!: () => void;
  let rejectReady!: (reason: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  // Assigned below, but referenced by closures defined above it.
  // eslint-disable-next-line prefer-const
  let reportFailure!: (message: string, cause?: unknown) => void;
  const postToFrame = (message: SnapshotShieldFrameMessage): void => {
    if (removed || !port) return;
    try {
      port.postMessage(message);
    } catch (error) {
      reportFailure('snapshot input shield message channel failed', error);
    }
  };
  /** Injects this shield's channel token so call sites only spell out the
   * message-specific fields. */
  const post = (message: WithoutToken<SnapshotShieldFrameMessage>): void => {
    postToFrame({ ...message, token } as SnapshotShieldFrameMessage);
  };
  /** A channel interaction is stale once the shield was removed or a newer
   * frame load re-keyed the port (generation bump); stale work must neither
   * touch shield state nor post replies on the current channel. */
  const isStale = (generation: number): boolean => removed || generation !== channelGeneration;

  const handleHover = async (message: SnapshotShieldPointerMoveMessage, generation: number): Promise<void> => {
    let preview: SnapshotShieldPreviewResult = { rect: null };
    try {
      if (onHover) preview = await onHover(message);
    } catch (error) {
      console.error('[howbeam] failed to preview snapshot target', error);
    }
    if (isStale(generation)) return;
    post({ type: SNAPSHOT_SHIELD_PREVIEW, requestId: message.requestId, rect: preview.rect });
  };

  const completeSelection = (
    selection: SnapshotShieldSelection | null,
    generation: number,
    captureId: number,
  ): void => {
    if (removed) return;
    const committed = selection ? { ...selection, id: nextSelectionId++ } : null;
    if (committed) {
      committedSelections.push(committed);
      lastUndoneSelection = null;
    }

    if (!isStale(generation)) {
      post({ type: SNAPSHOT_SHIELD_CAPTURE_COMPLETE, captureId, selection: committed });
    } else if (committed) {
      post({ type: SNAPSHOT_SHIELD_COMMIT, selection: committed });
    }
  };

  const handlePoint = async (message: SnapshotShieldPointerDownMessage, generation: number): Promise<void> => {
    let selection: SnapshotShieldSelection | null = null;
    try {
      selection = (await onPoint(message)) ?? null;
    } catch (error) {
      console.error('[howbeam] failed to handle snapshot shield pointer', error);
    }
    completeSelection(selection, generation, message.captureId);
  };

  const handleRegion = async (message: SnapshotShieldRegionCaptureMessage, generation: number): Promise<void> => {
    let selection: SnapshotShieldSelection | null = null;
    try {
      selection = (await onRegion?.(message)) ?? null;
    } catch (error) {
      console.error('[howbeam] failed to handle snapshot shield region', error);
    }
    completeSelection(selection, generation, message.captureId);
  };

  const handleControl = async (message: SnapshotShieldControlMessage, generation: number): Promise<void> => {
    let result: RecordingControlResult = { ok: false, error: t().runtime.shieldActionUnavailable };
    try {
      if (onControl) result = await onControl(message);
    } catch (error) {
      console.error('[howbeam] failed to handle snapshot toolbar command', error);
      result = { ok: false, error: t().runtime.shieldActionFailed };
    }
    if (isStale(generation)) return;

    // Undo/restore is DELIBERATELY tracked in three lockstep layers keyed by
    // the same background result: the page recorder's selection set
    // (content.ts onSnapshotControl), this channel's committedSelections
    // (which replay committed annotations into a reloaded shield frame), and
    // the shield page's overlay stack (snapshot-shield/overlay.ts). All three
    // must pop and push together or dedup and drawn annotations drift.
    if (result.ok && message.action === 'UNDO_LAST_CAPTURE') {
      lastUndoneSelection = committedSelections.pop() ?? null;
      if (lastUndoneSelection) {
        post({ type: SNAPSHOT_SHIELD_UNDO });
      }
    } else if (result.ok && message.action === 'RESTORE_LAST_CAPTURE' && lastUndoneSelection) {
      committedSelections.push(lastUndoneSelection);
      const restoredSelection = lastUndoneSelection;
      lastUndoneSelection = null;
      post({ type: SNAPSHOT_SHIELD_COMMIT, selection: restoredSelection });
    }

    post({ type: SNAPSHOT_SHIELD_CONTROL_RESULT, requestId: message.requestId, result });
  };

  const runWithoutShieldHitTesting = <T>(callback: () => T): T => {
    if (removed) return callback();
    setImportantStyle(host, 'pointer-events', 'none');
    setImportantStyle(frame, 'pointer-events', 'none');
    try {
      return callback();
    } finally {
      setImportantStyle(frame, 'pointer-events', 'auto');
      setImportantStyle(host, 'pointer-events', 'auto');
    }
  };

  const findMountParent = (): HTMLElement => {
    const activeModal = findModalAncestor(getDeepActiveElement());
    if (activeModal) return activeModal;

    const hitModal = runWithoutShieldHitTesting(() => {
      const points = [
        [window.innerWidth / 2, window.innerHeight / 2],
        [1, 1],
        [Math.max(window.innerWidth - 1, 0), Math.max(window.innerHeight - 1, 0)],
      ] as const;
      for (const [clientX, clientY] of points) {
        const modal = findModalAncestor(deepElementFromPoint(clientX, clientY));
        if (modal) return modal;
      }
      return null;
    });
    if (hitModal) return hitModal;

    const modalDialogs = Array.from(document.querySelectorAll('dialog')).filter(isModalDialog);
    const [only, ...others] = modalDialogs;
    return only && others.length === 0 ? only : document.documentElement;
  };

  // querySelector('dialog') per node is O(subtree); the element/child
  // pre-filter skips it for text nodes and childless elements, and coalescing
  // record processing to one animation frame keeps churny pages from paying
  // that cost once per microtask.
  const touchesDialogTree = (node: Node): boolean => {
    if (!(node instanceof Element)) return false;
    if (isDialogElement(node)) return true;
    return node.firstElementChild !== null && node.querySelector('dialog') !== null;
  };
  let pendingRemountRecords: MutationRecord[] = [];
  let pendingRemountFrame: number | null = null;
  const flushRemountCheck = () => {
    pendingRemountFrame = null;
    const records = pendingRemountRecords;
    pendingRemountRecords = [];
    if (removed) return;
    const modalTreeChanged = records.some((record) => {
      if (record.type === 'attributes') return isDialogElement(record.target);
      return [...record.addedNodes, ...record.removedNodes].some(touchesDialogTree);
    });
    if (!host.isConnected || modalTreeChanged) mountHost();
  };
  const observer = new MutationObserver((records) => {
    if (removed) return;
    pendingRemountRecords.push(...records);
    if (pendingRemountFrame === null) pendingRemountFrame = requestAnimationFrame(flushRemountCheck);
  });

  const mountHost = () => {
    let parent = findMountParent();
    if (!parent.isConnected) parent = document.documentElement;
    if (host.parentNode !== parent) {
      const hidePopover = (host as HTMLElement & { hidePopover?: () => void }).hidePopover;
      try {
        hidePopover?.call(host);
      } catch {
        // A closed popover throws in some browser versions.
      }
      const moveBefore = (parent as HTMLElement & {
        moveBefore?: (node: Node, child: Node | null) => void;
      }).moveBefore;
      if (host.isConnected && typeof moveBefore === 'function') moveBefore.call(parent, host, null);
      else parent.append(host);
    }
    const showPopover = (host as HTMLElement & { showPopover?: () => void }).showPopover;
    if (typeof showPopover !== 'function') return;
    try {
      if (!host.matches(':popover-open')) showPopover.call(host);
    } catch {
      // Already-open popovers throw in some browser versions.
    }
  };

  const remove = () => {
    if (removed) return;
    removed = true;
    clearTimeout(readyTimeout);
    observer.disconnect();
    if (pendingRemountFrame !== null) cancelAnimationFrame(pendingRemountFrame);
    pendingRemountFrame = null;
    pendingRemountRecords = [];
    void browser.storage.local.remove(tokenStorageKey).catch(() => {
      // The shield page may already have consumed (and removed) the record.
    });
    try {
      port?.close();
    } catch {
      // A failed or already-detached channel may reject cleanup.
    }
    port = null;
    host.remove();
    if (!ready) rejectReady(new Error('Snapshot input shield was removed before it became ready.'));
  };

  reportFailure = (message: string, cause?: unknown) => {
    if (removed) return;
    const runtimeFailure = ready;
    const error = cause instanceof Error ? cause : new Error(message);
    remove();
    console.error(`[howbeam] ${message}`, cause ?? '');
    if (runtimeFailure && onFailure) {
      void Promise.resolve(onFailure(error)).catch((handlerError) => {
        console.error('[howbeam] failed to recover from snapshot shield failure', handlerError);
      });
    }
  };

  const readyTimeout = setTimeout(
    () => reportFailure('snapshot input shield did not become ready before the startup timeout'),
    SHIELD_READY_TIMEOUT_MS,
  );

  // Park the secret in extension storage, then load the frame. Page scripts
  // cannot read extension storage, so only the extension-origin shield page
  // can recover the expected init token; the existing READY timeout above
  // still tears everything down if provisioning or the handshake stalls.
  void (async () => {
    try {
      const record: SnapshotShieldTokenRecord = { token, createdAt: Date.now() };
      await browser.storage.local.set({ [tokenStorageKey]: record });
      if (removed) {
        await browser.storage.local.remove(tokenStorageKey);
        return;
      }
      frame.src = frameUrl.href;
    } catch (error) {
      reportFailure('snapshot input shield token provisioning failed', error);
    }
  })();
  void sweepStaleShieldTokens(tokenStorageKey).catch(() => undefined);

  frame.addEventListener(
    'load',
    () => {
      // The frame mounts before token provisioning assigns src, so the
      // initial about:blank document (page origin) can fire load first;
      // posting the init there would neuter the transferred port.
      if (removed || !frame.contentWindow || !frame.src) return;
      const generation = ++channelGeneration;
      port?.close();
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = (event) => {
        if (isStale(generation)) return;
        if (!isSnapshotShieldPortMessage(event.data, token)) return;
        if (event.data.type === SNAPSHOT_SHIELD_READY) {
          if (!ready) {
            ready = true;
            clearTimeout(readyTimeout);
            resolveReady();
          }
          frame.focus({ preventScroll: true });
          for (const selection of committedSelections) {
            post({ type: SNAPSHOT_SHIELD_COMMIT, selection });
          }
          if (toolbarState) {
            post({ type: SNAPSHOT_SHIELD_TOOLBAR_STATE, state: toolbarState });
          }
          if (keyboardAnchors) {
            post({ type: SNAPSHOT_SHIELD_CANDIDATES, anchors: keyboardAnchors });
          }
          return;
        }
        if (event.data.type === SNAPSHOT_SHIELD_POINTER_MOVE) {
          void handleHover(event.data, generation);
          return;
        }
        if (event.data.type === SNAPSHOT_SHIELD_POINTER_DOWN) {
          void handlePoint(event.data, generation);
          return;
        }
        if (event.data.type === SNAPSHOT_SHIELD_REGION_CAPTURE) {
          void handleRegion(event.data, generation);
          return;
        }
        if (event.data.type === SNAPSHOT_SHIELD_CONTROL) {
          void handleControl(event.data, generation);
        }
      };
      port.onmessageerror = () => {
        if (generation === channelGeneration) {
          reportFailure('snapshot input shield message channel failed');
        }
      };
      port.start();

      const theme: ToolbarTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      const message: SnapshotShieldInitMessage = { type: SNAPSHOT_SHIELD_INIT, token, theme };
      try {
        frame.contentWindow.postMessage(message, frameUrl.origin, [channel.port2]);
      } catch (error) {
        reportFailure('snapshot input shield channel initialization failed', error);
      }
    },
  );

  frame.addEventListener('error', () => reportFailure('snapshot input shield page failed to load'), { once: true });
  mountHost();
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['open'],
  });

  return {
    ready: readyPromise,
    runWithoutShield: runWithoutShieldHitTesting,
    updateToolbar(state) {
      toolbarState = state;
      post({ type: SNAPSHOT_SHIELD_TOOLBAR_STATE, state });
    },
    sendKeyboardCandidates(anchors) {
      keyboardAnchors = anchors;
      post({ type: SNAPSHOT_SHIELD_CANDIDATES, anchors });
    },
    remove,
  };
}
