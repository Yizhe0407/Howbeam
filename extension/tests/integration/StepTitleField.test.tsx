// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Step } from '@/lib/storage/models';

vi.mock('@/lib/storage/step-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage/step-repository')>()),
  saveStepText: vi.fn(async (_id: string, _field: string, value: string) => value),
}));

import StepTitleField from '@/components/editor/StepTitleField';
import { EditorSaveProvider } from '@/lib/editor/editor-autosave';

function makeStep(title: string): Step {
  return {
    id: 'step-1',
    sessionId: 'session-1',
    order: 0,
    bounds: null,
    devicePixelRatio: 1,
    title,
    description: '',
    url: 'https://example.com',
    timestamp: 1,
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('StepTitleField', () => {
  it('is only the title: the step number names the field but is not printed beside it', () => {
    render(
      <EditorSaveProvider>
        <StepTitleField step={makeStep('點擊 Generate')} number={3} />
      </EditorSaveProvider>,
    );

    expect((screen.getByRole('textbox', { name: '步驟 3 標題' }) as HTMLInputElement).value).toBe('點擊 Generate');
    expect(screen.queryByText(/^3\.$/)).toBeNull();
  });
});
