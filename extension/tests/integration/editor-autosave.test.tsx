// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

const mocks = vi.hoisted(() => ({
  saveStepDescription: vi.fn(),
}));

vi.mock('@/lib/storage/step-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage/step-repository')>();
  return { ...actual, saveStepDescription: mocks.saveStepDescription };
});

import DescriptionField from '@/components/editor/DescriptionField';
import { EditorSaveProvider, useEditorSaveRegistry } from '@/lib/editor/editor-autosave';
import { readDescriptionDraft } from '@/lib/editor/description-drafts';
import { StepNotFoundError } from '@/lib/storage/step-repository';
import { type Step } from '@/lib/storage/models';

function makeStep(): Step {
  return {
    id: 'step-1',
    sessionId: 'session-1',
    order: 0,
    screenshotBlob: new Blob(['image'], { type: 'image/jpeg' }),
    bounds: null,
    devicePixelRatio: 1,
    description: '',
    url: 'https://example.com',
    timestamp: 1,
  };
}

function FlushButton() {
  const { flushAll } = useEditorSaveRegistry();
  return <button onClick={() => void flushAll()}>匯出前儲存</button>;
}

/** saveStepDescription resolves with the stored value; these mocks store exactly what they get. */
const storeAsSent = async (_id: string, description: string) => description;

/** A save that stores what it was sent once `gate` resolves. */
function storeAfter(gate: { promise: Promise<void> }) {
  return (_id: string, description: string) => gate.promise.then(() => description);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  mocks.saveStepDescription.mockReset();
  mocks.saveStepDescription.mockImplementation(storeAsSent);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('editor description autosave', () => {
  it('debounces writes while keeping save state out of the description UI', async () => {
    const pending = deferred();
    mocks.saveStepDescription.mockImplementationOnce(storeAfter(pending));
    render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} />
      </EditorSaveProvider>,
    );

    fireEvent.change(screen.getByLabelText('說明'), { target: { value: '新的說明' } });
    expect(screen.queryByText('尚未儲存')).toBeNull();
    act(() => vi.advanceTimersByTime(649));
    expect(mocks.saveStepDescription).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(mocks.saveStepDescription).toHaveBeenCalledWith('step-1', '新的說明');
    expect(screen.queryByText('正在儲存')).toBeNull();

    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(screen.queryByText('已儲存')).toBeNull();
  });

  it('serializes text entered during a pending write so the latest draft wins', async () => {
    const firstWrite = deferred();
    mocks.saveStepDescription.mockImplementationOnce(storeAfter(firstWrite)).mockImplementation(storeAsSent);
    render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} />
      </EditorSaveProvider>,
    );

    const field = screen.getByLabelText('說明');
    fireEvent.change(field, { target: { value: '第一版' } });
    await act(async () => {
      vi.advanceTimersByTime(650);
      await Promise.resolve();
    });
    fireEvent.change(field, { target: { value: '最後版本' } });

    await act(async () => {
      firstWrite.resolve();
      await firstWrite.promise;
      await Promise.resolve();
    });

    expect(mocks.saveStepDescription.mock.calls).toEqual([
      ['step-1', '第一版'],
      ['step-1', '最後版本'],
    ]);
    expect(screen.getByDisplayValue('最後版本')).toBeTruthy();
    expect(screen.queryByText('已儲存')).toBeNull();
  });

  it('flushes immediately for a parent operation before the debounce expires', async () => {
    render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} />
        <FlushButton />
      </EditorSaveProvider>,
    );

    fireEvent.change(screen.getByLabelText('說明'), { target: { value: '匯出內容' } });
    fireEvent.click(screen.getByRole('button', { name: '匯出前儲存' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.saveStepDescription).toHaveBeenCalledTimes(1);
    expect(mocks.saveStepDescription).toHaveBeenCalledWith('step-1', '匯出內容');
    expect(screen.queryByText('已儲存')).toBeNull();
  });

  it('retains a failed draft and saves it when the user retries', async () => {
    const saveError = new Error('temporary write failure');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.saveStepDescription.mockRejectedValueOnce(saveError).mockImplementation(storeAsSent);
    render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} />
      </EditorSaveProvider>,
    );

    const field = screen.getByLabelText('說明');
    fireEvent.change(field, { target: { value: '保留這段草稿' } });
    await act(async () => {
      vi.advanceTimersByTime(650);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByDisplayValue('保留這段草稿')).toBeTruthy();
    expect(screen.queryByText('無法儲存，草稿已保留；請重試。')).toBeNull();

    fireEvent.blur(field);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.saveStepDescription).toHaveBeenCalledTimes(2);
    expect(screen.getByDisplayValue('保留這段草稿')).toBeTruthy();
    expect(screen.queryByText('已儲存')).toBeNull();
    consoleError.mockRestore();
  });

  it('restores a synchronously kept draft after an interrupted close and commits it on reopen', async () => {
    const interruptedWrite = deferred();
    mocks.saveStepDescription.mockImplementationOnce(storeAfter(interruptedWrite)).mockImplementation(storeAsSent);
    const first = render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} />
      </EditorSaveProvider>,
    );

    fireEvent.change(screen.getByLabelText('說明'), { target: { value: '關閉前最後輸入' } });
    first.unmount();

    render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} />
      </EditorSaveProvider>,
    );
    expect(screen.getByDisplayValue('關閉前最後輸入')).toBeTruthy();
    expect(screen.queryByText('尚未儲存')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(650);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.saveStepDescription).toHaveBeenLastCalledWith('step-1', '關閉前最後輸入');
    expect(screen.queryByText('已儲存')).toBeNull();
  });

  it('clears the local draft only once the latest text is saved', async () => {
    const firstWrite = deferred();
    mocks.saveStepDescription.mockImplementationOnce(storeAfter(firstWrite)).mockImplementation(storeAsSent);
    render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} />
      </EditorSaveProvider>,
    );
    const field = screen.getByLabelText('說明');
    fireEvent.change(field, { target: { value: '第一版' } });
    await act(async () => {
      vi.advanceTimersByTime(650);
      await Promise.resolve();
    });
    fireEvent.change(field, { target: { value: '最後版' } });

    await act(async () => {
      firstWrite.resolve();
      await firstWrite.promise;
      await Promise.resolve();
    });
    expect(localStorage.length).toBe(0);
    expect(mocks.saveStepDescription.mock.calls.at(-1)).toEqual(['step-1', '最後版']);
  });

  it('keeps the local draft when the step row disappeared before the save', async () => {
    // The pre-unmount flush also logs the intentional StepNotFoundError.
    silenceIntentionalErrorLogs();
    mocks.saveStepDescription.mockRejectedValue(new StepNotFoundError('step-1'));
    render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} />
      </EditorSaveProvider>,
    );

    fireEvent.change(screen.getByLabelText('說明'), { target: { value: '刪除後仍要保留的輸入' } });
    await act(async () => {
      vi.advanceTimersByTime(650);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.saveStepDescription).toHaveBeenCalledWith('step-1', '刪除後仍要保留的輸入');
    // The typed text must stay recoverable: nothing was written.
    expect(readDescriptionDraft(makeStep())).toBe('刪除後仍要保留的輸入');
    expect(screen.getByDisplayValue('刪除後仍要保留的輸入')).toBeTruthy();
  });

  it('saves at once when the local draft cannot be kept', async () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} />
      </EditorSaveProvider>,
    );

    fireEvent.change(screen.getByLabelText('說明'), { target: { value: '沒有本機副本' } });
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.saveStepDescription).toHaveBeenCalledWith('step-1', '沒有本機副本');
    vi.restoreAllMocks();
  });

  async function settle(ms = 650) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    });
  }

  // Storage drops control characters such as \v; comparing the next save against the
  // unnormalized text would look like a conflict and silently stop every later save.
  it('saves text containing control characters and keeps saving what is typed afterwards', async () => {
    render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} />
      </EditorSaveProvider>,
    );
    const field = screen.getByLabelText('說明');

    fireEvent.change(field, { target: { value: 'a\vb\fc\u0007d\u0085e' } });
    await settle();
    expect(mocks.saveStepDescription).toHaveBeenLastCalledWith('step-1', 'abcde');
    expect(screen.getByDisplayValue('abcde')).toBeTruthy();

    fireEvent.change(field, { target: { value: 'abcde 之後' } });
    await settle();
    expect(mocks.saveStepDescription).toHaveBeenLastCalledWith('step-1', 'abcde 之後');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('compares the next save against the value storage returned, not the one it sent', async () => {
    mocks.saveStepDescription.mockImplementationOnce(async () => '儲存後的值');
    render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} />
      </EditorSaveProvider>,
    );
    const field = screen.getByLabelText('說明');

    fireEvent.change(field, { target: { value: '送出的值' } });
    await settle();
    expect(screen.getByDisplayValue('儲存後的值')).toBeTruthy();

    fireEvent.change(field, { target: { value: '下一版' } });
    await settle();
    expect(mocks.saveStepDescription).toHaveBeenLastCalledWith('step-1', '下一版');
  });

  it('says on the field that nothing is saved once the step is gone', async () => {
    silenceIntentionalErrorLogs();
    mocks.saveStepDescription.mockRejectedValue(new StepNotFoundError('step-1'));
    render(
      <EditorSaveProvider>
        <DescriptionField step={makeStep()} />
      </EditorSaveProvider>,
    );

    fireEvent.change(screen.getByLabelText('說明'), { target: { value: '寫給已刪除的步驟' } });
    await settle();

    expect(screen.getByRole('alert').textContent).toContain('尚未儲存：這個步驟已被刪除。');
    expect(screen.getByDisplayValue('寫給已刪除的步驟')).toBeTruthy();
  });
});
