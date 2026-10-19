import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordingState } from '@/lib/storage/recording-state';
import { makeRecordingState } from '../setup/recording-state';
import { flushAsyncWork, importBackground } from '../setup/background-test-utils';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

const mocks = await vi.hoisted(async () => (await import('../setup/background-test-utils')).makeBackgroundMocks());

vi.mock('wxt/browser', async () =>
  (await import('../setup/background-test-utils')).mockWxtBrowserModule(mocks));
vi.mock('@/lib/storage/step-repository', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStepRepositoryModule(mocks, importOriginal));
vi.mock('@/lib/storage/project-repository', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockProjectRepositoryModule(mocks, importOriginal));
vi.mock('@/lib/storage/storage', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStorageModule(mocks, importOriginal));
vi.mock('@/lib/recording/background/pending-undo-store', async () =>
  (await import('../setup/background-test-utils')).mockPendingUndoStoreModule(mocks));

const EDITOR_KEY = 'howbeam:extensionPageTab:editor';
const EDITOR_TAB = { tabId: 12, windowId: 4 };
const EXTENSION_PAGE_SENDER = { url: 'chrome-extension://extension-id/popup.html' };
const EDITOR_URL_PREFIX = 'chrome-extension://extension-id/editor.html';

let storedState: RecordingState;

async function openEditor(message: { sessionId?: string; entryId?: string } = {}): Promise<unknown> {
  const result = await mocks.messageListener?.({ type: 'OPEN_EDITOR', ...message }, EXTENSION_PAGE_SENDER);
  await flushAsyncWork();
  return result;
}

/** Puts an editor tab in the registry, as REGISTER_EXTENSION_PAGE would. */
function withRegisteredEditor(): void {
  mocks.sessionGet.mockImplementation(async (keys?: string | string[]) =>
    (keys === EDITOR_KEY || (Array.isArray(keys) && keys.includes(EDITOR_KEY))
      ? { [EDITOR_KEY]: EDITOR_TAB }
      : {}));
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.messageListener = null;
  storedState = makeRecordingState({ sessionId: null });
  mocks.getRecordingState.mockImplementation(async () => storedState);
  mocks.setRecordingState.mockImplementation(async (next: RecordingState) => {
    storedState = next;
  });
  // vi.clearAllMocks only clears calls; restore the implementations this suite deliberately overrides per test.
  mocks.sessionGet.mockResolvedValue({});
  mocks.sessionSet.mockResolvedValue(undefined);
  mocks.sessionRemove.mockResolvedValue(undefined);
  mocks.tabsSendMessage.mockResolvedValue(undefined);
  mocks.getProject.mockResolvedValue({ id: 'project-a', title: 'Project A' });
  mocks.getSteps.mockResolvedValue([]);
  mocks.tabsCreate.mockResolvedValue({ id: 77, windowId: 1 });
  mocks.tabsUpdate.mockResolvedValue(undefined);
  mocks.windowsUpdate.mockResolvedValue(undefined);
  mocks.tabsGet.mockResolvedValue({ id: 12, windowId: 4 });
  mocks.readPendingUndoRecord.mockResolvedValue(null);
  mocks.clearPendingUndoRecord.mockResolvedValue(undefined);
  mocks.savePendingUndoRecord.mockResolvedValue(undefined);
  mocks.executeScript.mockResolvedValue([]);
  await importBackground();
  await flushAsyncWork();
});

describe('the single editor opener', () => {
  it('creates the one editor tab when no page has registered', async () => {
    await expect(openEditor({ sessionId: 'project-a' })).resolves.toEqual({ ok: true });

    expect(mocks.tabsSendMessage).not.toHaveBeenCalled();
    expect(mocks.tabsCreate).toHaveBeenCalledExactlyOnceWith({
      url: `${EDITOR_URL_PREFIX}?sessionId=project-a`,
      active: true,
    });
  });

  it('focuses, and never navigates, an editor already showing this Project', async () => {
    withRegisteredEditor();
    mocks.tabsSendMessage.mockResolvedValue({ ok: true, ready: true });

    await expect(openEditor({ sessionId: 'project-a', entryId: 'step-3' })).resolves.toEqual({ ok: true });

    expect(mocks.tabsSendMessage).toHaveBeenCalledExactlyOnceWith(12, {
      type: 'EDITOR_HANDOFF',
      sessionId: 'project-a',
      entryId: 'step-3',
    });
    // The page selected the entry itself, so activation is the whole job.
    expect(mocks.tabsUpdate).toHaveBeenCalledExactlyOnceWith(12, { active: true });
    expect(mocks.windowsUpdate).toHaveBeenCalledExactlyOnceWith(4, { focused: true });
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });

  it('navigates the same tab to a different Project once the page consents', async () => {
    withRegisteredEditor();
    mocks.tabsSendMessage.mockResolvedValue({ ok: true, ready: false });

    await expect(openEditor({ sessionId: 'project-b' })).resolves.toEqual({ ok: true });

    expect(mocks.tabsUpdate).toHaveBeenCalledExactlyOnceWith(12, {
      url: `${EDITOR_URL_PREFIX}?sessionId=project-b`,
      active: true,
    });
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });

  it('surfaces a draft-blocked refusal through OpenEditorResult and still focuses the tab', async () => {
    withRegisteredEditor();
    mocks.tabsSendMessage.mockResolvedValue({ ok: false, error: '需要先確認要保留哪一份草稿。' });

    await expect(openEditor({ sessionId: 'project-b' })).resolves.toEqual({
      ok: false,
      error: '需要先確認要保留哪一份草稿。',
    });

    // Focused, not navigated: the page keeps its draft on screen.
    expect(mocks.tabsUpdate).toHaveBeenCalledExactlyOnceWith(12, { active: true });
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });

  it('navigates a tab that answers with an unshaped reply', async () => {
    withRegisteredEditor();
    mocks.tabsSendMessage.mockResolvedValue({ ok: true });

    await expect(openEditor({ sessionId: 'project-b' })).resolves.toEqual({ ok: true });

    expect(mocks.tabsUpdate).toHaveBeenCalledExactlyOnceWith(12, {
      url: `${EDITOR_URL_PREFIX}?sessionId=project-b`,
      active: true,
    });
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });

  it('navigates a tab that answers nothing at all but still exists', async () => {
    // A discarded or reloading tab has no listener; nothing worth preserving, so the record stays good and the tab is reused.
    withRegisteredEditor();
    mocks.tabsSendMessage.mockRejectedValue(new Error('Could not establish connection.'));

    await expect(openEditor({ sessionId: 'project-b' })).resolves.toEqual({ ok: true });

    expect(mocks.tabsGet).toHaveBeenCalledWith(12);
    expect(mocks.tabsUpdate).toHaveBeenCalledExactlyOnceWith(12, {
      url: `${EDITOR_URL_PREFIX}?sessionId=project-b`,
      active: true,
    });
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });

  it('drops a record whose tab is gone and creates one editor instead', async () => {
    withRegisteredEditor();
    mocks.tabsSendMessage.mockRejectedValue(new Error('Could not establish connection.'));
    mocks.tabsGet.mockRejectedValue(new Error('No tab with id: 12.'));

    await expect(openEditor({ sessionId: 'project-b' })).resolves.toEqual({ ok: true });

    expect(mocks.sessionRemove).toHaveBeenCalledWith(EDITOR_KEY);
    expect(mocks.tabsUpdate).not.toHaveBeenCalled();
    expect(mocks.tabsCreate).toHaveBeenCalledExactlyOnceWith({
      url: `${EDITOR_URL_PREFIX}?sessionId=project-b`,
      active: true,
    });
  });

  it('reports a missing Project without touching any tab', async () => {
    withRegisteredEditor();
    mocks.getProject.mockResolvedValue(undefined);

    await expect(openEditor({ sessionId: 'project-gone' })).resolves.toEqual({
      ok: false,
      error: '找不到這個專案。',
    });

    expect(mocks.tabsSendMessage).not.toHaveBeenCalled();
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });

  it('focuses whatever the open editor shows when recovery can name no Project', async () => {
    withRegisteredEditor();

    await expect(openEditor()).resolves.toEqual({ ok: true });

    // No Project to hand over means no handshake to negotiate.
    expect(mocks.tabsSendMessage).not.toHaveBeenCalled();
    expect(mocks.tabsUpdate).toHaveBeenCalledExactlyOnceWith(12, { active: true });
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });

  it('marks editor recovery when opening throws, and reports the retry message', async () => {
    silenceIntentionalErrorLogs();
    storedState = makeRecordingState({ sessionId: 'project-a' });
    mocks.sessionGet.mockRejectedValue(new Error('session storage is unavailable'));

    await expect(openEditor({ sessionId: 'project-a' })).resolves.toEqual({
      ok: false,
      error: '無法開啟編輯器，請再試一次。',
    });

    expect(storedState.recoverableError?.code).toBe('EDITOR_OPEN_FAILED');
  });
});

describe('finishing a recording twice', () => {
  it('reuses the editor opened by the first finish', async () => {
    storedState = makeRecordingState({
      operation: 'recording',
      isRecording: true,
      phase: 'recording',
      sessionId: 'project-a',
      tabId: 4,
      runId: 'run-1',
    });
    mocks.tabsGet.mockResolvedValue({ id: 4, windowId: 1, active: true, url: 'https://example.com/flow' });

    const first = await mocks.messageListener?.(
      { type: 'FINISH_RECORDING', runId: 'run-1' },
      EXTENSION_PAGE_SENDER,
    );
    await flushAsyncWork();
    expect(first).toMatchObject({ ok: true });
    expect(mocks.tabsCreate).toHaveBeenCalledTimes(1);

    // The created tab announces itself, exactly as the editor page does on mount.
    withRegisteredEditor();
    mocks.tabsSendMessage.mockResolvedValue({ ok: true, ready: true });
    await openEditor({ sessionId: 'project-a' });

    expect(mocks.tabsCreate).toHaveBeenCalledTimes(1);
  });
});

describe('opening the editor from another extension page', () => {
  const LIBRARY_SENDER = {
    url: 'chrome-extension://extension-id/library.html',
    frameId: 0,
    tab: { id: 30, windowId: 2, url: 'chrome-extension://extension-id/library.html' },
  };

  async function openFrom(sender: unknown, message: Record<string, unknown>): Promise<unknown> {
    const result = await mocks.messageListener?.({ type: 'OPEN_EDITOR', ...message }, sender);
    await flushAsyncWork();
    return result;
  }

  it('turns the requesting page into the editor when none is open', async () => {
    await expect(openFrom(LIBRARY_SENDER, { sessionId: 'project-a', inPlace: true })).resolves.toEqual({ ok: true });

    expect(mocks.tabsUpdate).toHaveBeenCalledExactlyOnceWith(30, {
      url: `${EDITOR_URL_PREFIX}?sessionId=project-a`,
      active: true,
    });
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });

  it('switches to the editor already open elsewhere instead of making a second one', async () => {
    withRegisteredEditor();
    mocks.tabsSendMessage.mockResolvedValue({ ok: true, ready: false });

    await expect(openFrom(LIBRARY_SENDER, { sessionId: 'project-b', inPlace: true })).resolves.toEqual({ ok: true });

    expect(mocks.tabsUpdate).toHaveBeenCalledExactlyOnceWith(12, {
      url: `${EDITOR_URL_PREFIX}?sessionId=project-b`,
      active: true,
    });
    expect(mocks.tabsUpdate).not.toHaveBeenCalledWith(30, expect.anything());
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });

  it('takes the requesting tab when the remembered editor turns out to be gone', async () => {
    withRegisteredEditor();
    mocks.tabsSendMessage.mockRejectedValue(new Error('Could not establish connection.'));
    mocks.tabsGet.mockRejectedValue(new Error('No tab with id: 12'));

    await expect(openFrom(LIBRARY_SENDER, { sessionId: 'project-a', inPlace: true })).resolves.toEqual({ ok: true });

    expect(mocks.tabsUpdate).toHaveBeenCalledExactlyOnceWith(30, {
      url: `${EDITOR_URL_PREFIX}?sessionId=project-a`,
      active: true,
    });
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['the popup, which has no tab of its own', EXTENSION_PAGE_SENDER],
    ['the editor itself', {
      url: 'chrome-extension://extension-id/editor.html?sessionId=project-a',
      frameId: 0,
      tab: { id: 12, url: 'chrome-extension://extension-id/editor.html?sessionId=project-a' },
    }],
  ])('opens a tab of its own when the request comes from %s', async (_label, sender) => {
    await openFrom(sender, { sessionId: 'project-a', inPlace: true });

    expect(mocks.tabsCreate).toHaveBeenCalledExactlyOnceWith({ url: `${EDITOR_URL_PREFIX}?sessionId=project-a`, active: true });
    expect(mocks.tabsUpdate).not.toHaveBeenCalled();
  });

  it('never lets a web page have its own tab turned into the editor', async () => {
    const url = 'https://evil.example/library.html';
    await openFrom({ url, frameId: 0, tab: { id: 31, url } }, { sessionId: 'project-a', inPlace: true });

    expect(mocks.tabsUpdate).not.toHaveBeenCalledWith(31, expect.anything());
  });
});

describe('extension page registry', () => {
  const LIBRARY_KEY = 'howbeam:extensionPageTab:library';
  const OPTIONS_KEY = 'howbeam:extensionPageTab:options';

  async function register(page: string, tabId: number): Promise<unknown> {
    const url = `chrome-extension://extension-id/${page}`;
    const result = await mocks.messageListener?.({ type: 'REGISTER_EXTENSION_PAGE' }, { url, frameId: 0, tab: { id: tabId, windowId: 2, url } });
    await flushAsyncWork();
    return result;
  }

  it('remembers a tab as only the page it shows now', async () => {
    // Tab 30 was the library and has just navigated to settings.
    mocks.sessionGet.mockImplementation(async (keys?: string | string[]) =>
      (Array.isArray(keys) && keys.includes(LIBRARY_KEY) ? { [LIBRARY_KEY]: { tabId: 30, windowId: 2 } } : {}));

    await expect(register('options.html', 30)).resolves.toBe(true);

    expect(mocks.sessionRemove).toHaveBeenCalledWith([LIBRARY_KEY]);
    expect(mocks.sessionSet).toHaveBeenCalledWith({ [OPTIONS_KEY]: { tabId: 30, windowId: 2 } });
  });

  it('leaves other tabs’ records alone', async () => {
    mocks.sessionGet.mockImplementation(async (keys?: string | string[]) =>
      (Array.isArray(keys) && keys.includes(LIBRARY_KEY) ? { [LIBRARY_KEY]: { tabId: 31, windowId: 2 } } : {}));

    await register('options.html', 30);

    expect(mocks.sessionRemove).not.toHaveBeenCalled();
  });

  it.each(['welcome.html', 'options.html', 'library.html'])('accepts %s as a registering page', async (page) => {
    await expect(register(page, 40)).resolves.toBe(true);
  });
});
