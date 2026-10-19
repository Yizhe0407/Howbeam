// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installStepRailDomStubs, removeStepRailDomStubs } from '../setup/step-rail-dom';
import StepRail from '@/components/editor/StepRail';
import { type StepEntry } from '@/lib/storage/models';
import type { ProjectSection } from '@/lib/project/project-sections';
import { makeEntry } from '../setup/step-entries';
import { TooltipProvider } from '@/components/ui/tooltip';

// StepRail's "continue recording" button uses the shadcn Tooltip, which
// requires a TooltipProvider ancestor — wrap every render() the same way the
// app roots do.
function render(ui: Parameters<typeof rtlRender>[0], options?: Parameters<typeof rtlRender>[1]) {
  return rtlRender(ui, { wrapper: TooltipProvider, ...options });
}

function makeGroupEntry(id: string, annotationCount: number): StepEntry {
  const single = makeEntry(id, 0);
  if (single.kind !== 'single') throw new Error('Expected a single entry fixture.');
  return {
    kind: 'group',
    anchor: { ...single.step, bounds: null, groupId: id },
    annotations: Array.from({ length: annotationCount }, (_, index) => {
      const annotation = makeEntry(`${id}-annotation-${index + 1}`, index + 1);
      if (annotation.kind !== 'single') throw new Error('Expected a single annotation fixture.');
      const { screenshotBlob: _screenshotBlob, ...step } = annotation.step;
      return { ...step, groupId: id };
    }),
  };
}

describe('StepRail keyboard navigation', () => {
  beforeEach(installStepRailDomStubs);

  afterEach(removeStepRailDomStubs);

  it('只為選取或接近 viewport 的步驟建立圖片 URL', async () => {
    const observers: Array<{ callback: IntersectionObserverCallback; target?: Element }> = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        private record: { callback: IntersectionObserverCallback; target?: Element };
        constructor(callback: IntersectionObserverCallback) {
          this.record = { callback };
          observers.push(this.record);
        }
        observe(target: Element) { this.record.target = target; }
        disconnect() {}
        unobserve() {}
        takeRecords() { return []; }
        root = null;
        rootMargin = '320px';
        thresholds = [0];
      },
    );
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');

    render(
      <StepRail
        entries={[makeEntry('step-1', 0), makeEntry('step-2', 1), makeEntry('step-3', 2)]}
        selectedEntryId="step-1"
        onSelect={vi.fn()}
        onReorder={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(observers).toHaveLength(2);

    act(() => {
      const record = observers[0];
      record.callback([{ isIntersecting: true, target: record.target } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2));
  });

  it('handles arrows only while focus is inside the rail', () => {
    const onSelect = vi.fn();
    render(
      <>
        <button type="button">Dialog control</button>
        <StepRail
          entries={[makeEntry('step-1', 0), makeEntry('step-2', 1)]}
          selectedEntryId="step-1"
          onSelect={onSelect}
          onReorder={vi.fn().mockResolvedValue(undefined)}
        />
      </>,
    );

    const railSelection = screen.getByRole('button', { name: '開啟步驟 1' });
    railSelection.focus();
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(onSelect).toHaveBeenCalledWith('step-2');

    onSelect.mockClear();
    screen.getByRole('button', { name: 'Dialog control' }).focus();
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('每個項目只顯示編號與縮圖，不顯示說明或標註摘要', () => {
    render(
      <StepRail
        entries={[makeGroupEntry('snapshot-1', 2), makeEntry('step-2', 1)]}
        selectedEntryId="snapshot-1"
        onSelect={vi.fn()}
        onReorder={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const rail = screen.getByRole('navigation', { name: '步驟導覽' });
    expect(rail.textContent).not.toContain('單頁標註');
    expect(rail.textContent).not.toContain('2 個標註');
    expect(rail.textContent).not.toContain('Step 2');
    expect(screen.getByRole('button', { name: '開啟步驟 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '開啟步驟 2' })).toBeTruthy();
  });

  it('只顯示單一目前步驟，不提供批次選取控制', () => {
    render(
      <StepRail
        entries={[makeEntry('step-1', 0), makeEntry('step-2', 1)]}
        selectedEntryId="step-1"
        onSelect={vi.fn()}
        onReorder={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByRole('button', { name: '開啟步驟 1' }).getAttribute('aria-current')).toBe('step');
    expect(screen.getByRole('button', { name: '開啟步驟 2' }).getAttribute('aria-current')).toBeNull();
    expect(screen.queryByRole('button', { name: /選取步驟/ })).toBeNull();
  });

  it('把補錄遺漏步驟導向接續錄製，並在其他操作進行時停用', () => {
    const onContinueRecording = vi.fn();
    const { rerender } = render(
      <StepRail
        entries={[makeEntry('step-1', 0)]}
        selectedEntryId="step-1"
        onSelect={vi.fn()}
        onReorder={vi.fn().mockResolvedValue(undefined)}
        onContinueRecording={onContinueRecording}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '接續錄製' }));
    expect(onContinueRecording).toHaveBeenCalledOnce();

    rerender(
      <StepRail
        entries={[makeEntry('step-1', 0)]}
        selectedEntryId="step-1"
        onSelect={vi.fn()}
        onReorder={vi.fn().mockResolvedValue(undefined)}
        onContinueRecording={onContinueRecording}
        reorderDisabled
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '接續錄製' }));
    expect(onContinueRecording).toHaveBeenCalledOnce();
  });

  it('每兩個步驟之間都能在該處接續錄製，並在其他操作進行時停用', () => {
    const onContinueRecording = vi.fn();
    const entries = [makeEntry('step-1', 0), makeEntry('step-2', 1), makeEntry('step-3', 2)];
    const { rerender } = render(
      <StepRail
        entries={entries}
        selectedEntryId="step-1"
        onSelect={vi.fn()}
        onReorder={vi.fn().mockResolvedValue(undefined)}
        onContinueRecording={onContinueRecording}
      />,
    );

    // The seam after the last step is the bottom button's job.
    expect(screen.queryByRole('button', { name: '在第 3 步後接續錄製' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '在第 1 步後接續錄製' }));
    expect(onContinueRecording).toHaveBeenCalledWith('step-1');

    rerender(
      <StepRail
        entries={entries}
        selectedEntryId="step-1"
        onSelect={vi.fn()}
        onReorder={vi.fn().mockResolvedValue(undefined)}
        onContinueRecording={onContinueRecording}
        reorderDisabled
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '在第 2 步後接續錄製' }));
    expect(onContinueRecording).toHaveBeenCalledOnce();
  });

  it('步驟之間可以從下一步開始新章節；已是章節開頭的步驟不提供', () => {
    const onStartSection = vi.fn();
    render(
      <StepRail
        entries={[makeEntry('step-1', 0), makeEntry('step-2', 1), makeEntry('step-3', 2)]}
        selectedEntryId="step-1"
        sections={[{ id: 'section-1', title: '準備', startEntryId: 'step-3' }]}
        onSelect={vi.fn()}
        onReorder={vi.fn().mockResolvedValue(undefined)}
        onStartSection={onStartSection}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '從第 2 步開始新章節' }));
    expect(onStartSection).toHaveBeenCalledWith('step-2');
    // Step 3 already begins a section.
    expect(screen.queryByRole('button', { name: '從第 3 步開始新章節' })).toBeNull();
  });

  it('章節選單的重新命名只請求開啟對話框，列表裡不出現輸入框', async () => {
    const onRenameSection = vi.fn();
    render(
      <StepRail
        entries={[makeEntry('step-1', 0), makeEntry('step-2', 1)]}
        selectedEntryId="step-1"
        sections={[{ id: 'section-1', title: '準備', startEntryId: 'step-2' }]}
        onSelect={vi.fn()}
        onReorder={vi.fn().mockResolvedValue(undefined)}
        onRenameSection={onRenameSection}
        onDeleteSection={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '章節操作' }));
    fireEvent.click(await screen.findByRole('button', { name: '重新命名' }));
    expect(onRenameSection).toHaveBeenCalledWith('section-1');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('每張步驟卡常駐顯示拖曳把手，不倚賴 hover 才浮現', () => {
    render(
      <StepRail
        entries={[makeEntry('step-1', 0), makeEntry('step-2', 1)]}
        selectedEntryId="step-1"
        onSelect={vi.fn()}
        onReorder={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const handles = screen.getAllByRole('button', { name: '拖曳排序' });
    expect(handles).toHaveLength(2);
    for (const handle of handles) {
      const wrapper = handle.parentElement!;
      expect(wrapper.className).not.toContain('opacity-0');
      expect(handle.getAttribute('aria-roledescription')).toBe('可拖曳的排序控制項');
    }
  });

  it('操作進行中時停用排序把手，且不再顯示文字提示', () => {
    render(
      <StepRail
        entries={[makeEntry('step-1', 0), makeEntry('step-2', 1)]}
        selectedEntryId="step-1"
        onSelect={vi.fn()}
        onReorder={vi.fn().mockResolvedValue(undefined)}
        reorderDisabled
      />,
    );

    expect(screen.queryByText('拖曳排序', { selector: 'span' })).toBeNull();
    for (const handle of screen.getAllByRole('button', { name: '拖曳排序' })) {
      expect((handle as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('捲動時才標記 data-scrolling 顯示捲軸，停止後自動移除', () => {
    vi.useFakeTimers();
    try {
      render(
        <StepRail
          entries={[makeEntry('step-1', 0), makeEntry('step-2', 1)]}
          selectedEntryId="step-1"
          onSelect={vi.fn()}
          onReorder={vi.fn().mockResolvedValue(undefined)}
        />,
      );
      const list = screen.getByRole('list', { name: '可重新排序的步驟清單' });
      expect(list.hasAttribute('data-scrolling')).toBe(false);

      fireEvent.scroll(list);
      expect(list.hasAttribute('data-scrolling')).toBe(true);

      act(() => { vi.advanceTimersByTime(1_000); });
      expect(list.hasAttribute('data-scrolling')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('桌面左欄依內容高度呈現，清單過長時才在欄內捲動', () => {
    render(
      <StepRail
        entries={[makeEntry('step-1', 0)]}
        selectedEntryId="step-1"
        onSelect={vi.fn()}
        onReorder={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const rail = screen.getByRole('navigation', { name: '步驟導覽' });
    const list = screen.getByRole('list', { name: '可重新排序的步驟清單' });
    expect(rail.className).toContain('lg:self-start');
    expect(rail.className).toContain('lg:max-h-[calc(100%-3rem)]');
    expect(list.className).toContain('lg:min-h-0');
    expect(list.className).toContain('lg:overflow-y-auto');
  });

  it('選取步驟只以外框標示，不將整列染成藍灰色', () => {
    render(
      <StepRail
        entries={[makeEntry('step-1', 0), makeEntry('step-2', 1)]}
        selectedEntryId="step-2"
        onSelect={vi.fn()}
        onReorder={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const selectedRow = screen.getByRole('button', { name: '開啟步驟 2' }).closest<HTMLElement>('[data-active]')!;
    expect(selectedRow.className).toContain('bg-card');
    expect(selectedRow.className).not.toContain('bg-[#e5ecf6]');
    const outline = selectedRow.querySelector<HTMLElement>('[data-howbeam-selected-step-outline]');
    expect(outline?.className).toContain('howbeam-selected-step-outline');
    expect(outline?.className).toContain('z-10');
    expect(outline?.className).toContain('border-2');
    expect(outline?.getAttribute('style')).toBeNull();
  });

  it('把章節標題與其起始步驟放在同一個 sortable 項目', () => {
    const sections: ProjectSection[] = [{ id: 'section-1', title: '準備工作', startEntryId: 'step-2' }];
    render(
      <StepRail
        entries={[makeEntry('step-1', 0), makeEntry('step-2', 1)]}
        selectedEntryId="step-1"
        sections={sections}
        onSelect={vi.fn()}
        onRenameSection={vi.fn()}
        onDeleteSection={vi.fn().mockResolvedValue(undefined)}
        onReorder={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const heading = screen.getByRole('heading', { name: '準備工作', level: 2 });
    const startButton = screen.getByRole('button', { name: '開啟步驟 2' });
    expect(heading.closest('li')).toBe(startButton.closest('li'));
    expect(screen.getByRole('button', { name: '開啟步驟 1' }).closest('li')).not.toBe(heading.closest('li'));
  });

});
