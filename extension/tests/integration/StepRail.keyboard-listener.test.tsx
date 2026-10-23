// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { useState } from 'react';
import { fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installStepRailDomStubs, removeStepRailDomStubs } from '../setup/step-rail-dom';
import StepRail from '@/components/editor/StepRail';
import { makeEntry } from '../setup/step-entries';
import { TooltipProvider } from '@/components/ui/tooltip';
import { itemAt } from '../setup/item-at';

// StepRail's "continue recording" button uses the shadcn Tooltip, which
// requires a TooltipProvider ancestor — wrap every render() the same way the
// app roots do.
function render(ui: Parameters<typeof rtlRender>[0], options?: Parameters<typeof rtlRender>[1]) {
  return rtlRender(ui, { wrapper: TooltipProvider, ...options });
}

const ENTRIES = [makeEntry('step-1', 0), makeEntry('step-2', 1), makeEntry('step-3', 2)];

describe('StepRail arrow-key listener stability', () => {
  beforeEach(installStepRailDomStubs);

  afterEach(removeStepRailDomStubs);

  it('registers the window keydown listener once despite parent re-renders', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    function Parent() {
      const [tick, setTick] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setTick((value) => value + 1)}>
            Re-render {tick}
          </button>
          {/* Inline arrow function: a fresh identity on every parent render. */}
          <StepRail
            entries={ENTRIES}
            selectedEntryId="step-1"
            onSelect={(id) => void id}
            onReorder={vi.fn().mockResolvedValue(undefined)}
          />
        </>
      );
    }

    render(<Parent />);
    const keydownAddsAfterMount = addSpy.mock.calls.filter(([type]) => type === 'keydown').length;

    const rerender = screen.getByRole('button', { name: /Re-render/ });
    fireEvent.click(rerender);
    fireEvent.click(rerender);
    fireEvent.click(rerender);

    expect(addSpy.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(keydownAddsAfterMount);
    expect(removeSpy.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(0);
  });

  it('navigates with the latest callback and selection after a re-render', () => {
    const selected: string[] = [];

    function Parent() {
      const [selectedEntryId, setSelectedEntryId] = useState('step-1');
      return (
        <StepRail
          entries={ENTRIES}
          selectedEntryId={selectedEntryId}
          onSelect={(id) => {
            selected.push(id);
            setSelectedEntryId(id);
          }}
          onReorder={vi.fn().mockResolvedValue(undefined)}
        />
      );
    }

    render(<Parent />);
    screen.getByRole('button', { name: '開啟步驟 1' }).focus();

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    screen.getByRole('button', { name: '開啟步驟 2' }).focus();
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    screen.getByRole('button', { name: '開啟步驟 3' }).focus();
    fireEvent.keyDown(window, { key: 'ArrowUp' });

    expect(selected).toEqual(['step-2', 'step-3', 'step-2']);
  });

  it('reorders a step from the keyboard without the rail arrow handler also changing the selection', async () => {
    // jsdom has no layout; give each row a distinct vertical slot so the
    // sortable keyboard coordinates can tell which neighbour is "below".
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const row = this.closest('li');
      const index = row ? Array.from(row.parentElement?.children ?? []).indexOf(row) : 0;
      const top = index * 100;
      return { x: 0, y: top, top, bottom: top + 90, left: 0, right: 200, width: 200, height: 90, toJSON: () => ({}) } as DOMRect;
    });
    const onSelect = vi.fn();
    const onReorder = vi.fn().mockResolvedValue(undefined);
    render(<StepRail entries={ENTRIES} selectedEntryId="step-1" onSelect={onSelect} onReorder={onReorder} />);

    const handle = itemAt(screen.getAllByRole('button', { name: '拖曳排序' }), 0);
    handle.focus();
    fireEvent.keyDown(handle, { code: 'Space', key: ' ' });
    await waitFor(() => expect(handle.getAttribute('aria-pressed')).toBe('true'));
    fireEvent.keyDown(document, { code: 'ArrowDown', key: 'ArrowDown' });
    fireEvent.keyDown(document, { code: 'Space', key: ' ' });

    await waitFor(() => expect(onReorder).toHaveBeenCalledOnce());
    expect(itemAt(onReorder.mock.calls, 0)[0]).toEqual([
      { kind: 'entry', id: 'step-2' },
      { kind: 'entry', id: 'step-1' },
      { kind: 'entry', id: 'step-3' },
    ]);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
