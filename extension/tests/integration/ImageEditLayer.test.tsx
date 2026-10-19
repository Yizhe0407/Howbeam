// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import ImageEditLayer from '@/components/editor/ImageEditLayer';
import type { ImageEditItem } from '@/lib/editor/image-edit-items';
import { DEFAULT_IMAGE_EDIT_STYLE } from '@/lib/editor/image-edit-style';
import { IMAGE_EDIT_LIMITS } from '@/lib/storage/image-edit-model';

const size = { width: 400, height: 200 };
const mask: ImageEditItem = { id: 'mask-1', kind: 'redaction', bounds: { x: 100, y: 50, width: 80, height: 40 } };
const rect: ImageEditItem = { id: 'rect-1', kind: 'rect', bounds: { x: 20, y: 20, width: 60, height: 30 }, width: 2, fill: 'none' as const, color: '#ff4747' };
const text: ImageEditItem = { id: 'text-1', kind: 'text', bounds: { x: 200, y: 100, width: 100, height: 30 }, text: 'Hello', fontSize: 24, look: 'plain' as const, color: '#111111' };
const arrow: ImageEditItem = { id: 'arrow-1', kind: 'arrow', from: { x: 10, y: 150 }, to: { x: 110, y: 190 }, width: 4, color: '#2f6fed' };

beforeAll(() => {
  // jsdom has no layout or pointer capture: 1 CSS px of image == 1 client px.
  Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0, toJSON: () => ({}) });
  Element.prototype.setPointerCapture = () => undefined;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(cleanup);

function setup(overrides: Partial<React.ComponentProps<typeof ImageEditLayer>> = {}) {
  const handlers = {
    onSelect: vi.fn(), onCreate: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn(), onDraft: vi.fn(),
    onStartTextEdit: vi.fn(), onFinishTextEdit: vi.fn(), onPanStart: vi.fn(),
  };
  const view = render(
    <ImageEditLayer
      items={[mask]}
      tool="redact"
      size={size}
      style={DEFAULT_IMAGE_EDIT_STYLE}
      selectedId={null}
      editingText={null}
      {...handlers}
      {...overrides}
    />,
  );
  const layer = view.container.querySelector('[data-howbeam-image-edit-layer]') as HTMLElement;
  return { ...handlers, layer, container: view.container };
}

const chrome = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-howbeam-edit-item="${id}"]`) as HTMLElement;

describe('ImageEditLayer creating', () => {
  it('creates a mask from a drag, reporting a live draft on the way', () => {
    const { layer, onCreate, onDraft } = setup();
    fireEvent.pointerDown(layer, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerMove(layer, { clientX: 60, clientY: 40 });
    expect(onDraft).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'redaction', bounds: { x: 10, y: 10, width: 50, height: 30 } }));
    fireEvent.pointerUp(layer, { clientX: 60, clientY: 40 });
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'redaction', bounds: { x: 10, y: 10, width: 50, height: 30 } }));
    expect(onDraft).toHaveBeenLastCalledWith(null);
  });

  it('creates a styled box and an arrow with the active style', () => {
    const style = { ...DEFAULT_IMAGE_EDIT_STYLE, color: '#22a559', strokeWidth: 6 };
    const box = setup({ tool: 'rect', style });
    fireEvent.pointerDown(box.layer, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerMove(box.layer, { clientX: 60, clientY: 40 });
    fireEvent.pointerUp(box.layer, { clientX: 60, clientY: 40 });
    expect(box.onCreate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rect', fill: 'none' as const, color: '#22a559', width: 6 }));
    cleanup();

    const line = setup({ tool: 'arrow' });
    fireEvent.pointerDown(line.layer, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerMove(line.layer, { clientX: 110, clientY: 90 });
    fireEvent.pointerUp(line.layer, { clientX: 110, clientY: 90 });
    expect(line.onCreate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'arrow', from: { x: 10, y: 10 }, to: { x: 110, y: 90 } }));
  });

  it('starts a text box from a plain click with the text tool', () => {
    const { layer, onCreate } = setup({ tool: 'text' });
    fireEvent.pointerDown(layer, { clientX: 50, clientY: 60, button: 0 });
    fireEvent.pointerUp(layer, { clientX: 50, clientY: 60 });
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'text', text: '' }));
  });

  it('ignores a stray click that is too small to be a shape', () => {
    const { layer, onCreate } = setup({ tool: 'rect' });
    fireEvent.pointerDown(layer, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerUp(layer, { clientX: 10, clientY: 10 });
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('pans instead of creating with the pointer tool', () => {
    const { layer, onCreate, onPanStart, onSelect } = setup({ tool: 'select' });
    fireEvent.pointerDown(layer, { clientX: 10, clientY: 10, button: 0 });
    expect(onSelect).toHaveBeenCalledWith(null);
    expect(onPanStart).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(layer, { clientX: 10, clientY: 10 });
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe('ImageEditLayer drawing over existing items', () => {
  it('draws a new box over a mask with the box tool instead of moving the mask', () => {
    const { layer, container, onCreate, onUpdate, onSelect } = setup({ tool: 'rect' });
    // Items let presses through to the image while a drawing tool is active.
    expect(chrome(container, 'mask-1').className).toContain('pointer-events-none');
    // Even a press that lands on the mask itself draws.
    fireEvent.pointerDown(chrome(container, 'mask-1'), { clientX: 120, clientY: 60, button: 0 });
    fireEvent.pointerMove(layer, { clientX: 170, clientY: 85 });
    fireEvent.pointerUp(layer, { clientX: 170, clientY: 85 });
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalledWith('mask-1');
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rect', bounds: { x: 120, y: 60, width: 50, height: 25 } }));
  });

  it('draws a new mask over a mask, and does not grab outlines while drawing', () => {
    const masking = setup({ items: [mask, rect] });
    expect(masking.container.querySelector('svg rect')).toBeNull();
    fireEvent.pointerDown(chrome(masking.container, 'mask-1'), { clientX: 110, clientY: 55, button: 0 });
    fireEvent.pointerMove(masking.layer, { clientX: 150, clientY: 75 });
    fireEvent.pointerUp(masking.layer, { clientX: 150, clientY: 75 });
    expect(masking.onUpdate).not.toHaveBeenCalled();
    expect(masking.onCreate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'redaction', bounds: { x: 110, y: 55, width: 40, height: 20 } }));
  });

  it('keeps the handles of the selected item usable while drawing', () => {
    const { layer, container, onUpdate, onCreate } = setup({ tool: 'redact', selectedId: 'mask-1' });
    const handle = container.querySelector('[data-howbeam-edit-handle="se"]') as HTMLElement;
    fireEvent.pointerDown(handle, { clientX: 180, clientY: 90, button: 0 });
    fireEvent.pointerMove(layer, { clientX: 200, clientY: 100 });
    fireEvent.pointerUp(layer, { clientX: 200, clientY: 100 });
    expect(onCreate).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'mask-1', bounds: { x: 100, y: 50, width: 100, height: 50 } }));
  });
});

describe('ImageEditLayer moving and resizing', () => {
  it('moves a mask by dragging it and reports the final item once', () => {
    const { layer, container, onUpdate, onSelect } = setup({ tool: 'select' });
    fireEvent.pointerDown(chrome(container, 'mask-1'), { clientX: 120, clientY: 60, button: 0 });
    fireEvent.pointerMove(layer, { clientX: 150, clientY: 80 });
    fireEvent.pointerUp(layer, { clientX: 150, clientY: 80 });
    expect(onSelect).toHaveBeenCalledWith('mask-1');
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'mask-1', bounds: { x: 130, y: 70, width: 80, height: 40 } }));
  });

  it('grabs a rectangle by its outline stroke, not its inside', () => {
    const { layer, container, onUpdate } = setup({ items: [rect, mask], tool: 'select' });
    const stroke = container.querySelector('svg rect') as SVGElement;
    fireEvent.pointerDown(stroke, { clientX: 20, clientY: 30, button: 0 });
    fireEvent.pointerMove(layer, { clientX: 40, clientY: 40 });
    fireEvent.pointerUp(layer, { clientX: 40, clientY: 40 });
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'rect-1', bounds: { x: 40, y: 30, width: 60, height: 30 } }));
    // The inside of the box is not a hit target of its own: its chrome ignores the pointer.
    expect(chrome(container, 'rect-1').className).toContain('pointer-events-none');
  });

  it('resizes through a corner handle of a selected box', () => {
    const { layer, container, onUpdate } = setup({ selectedId: 'mask-1' });
    const handle = container.querySelector('[data-howbeam-edit-handle="se"]') as HTMLElement;
    fireEvent.pointerDown(handle, { clientX: 180, clientY: 90, button: 0 });
    fireEvent.pointerMove(layer, { clientX: 200, clientY: 100 });
    fireEvent.pointerUp(layer, { clientX: 200, clientY: 100 });
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ bounds: { x: 100, y: 50, width: 100, height: 50 } }));
  });

  it('moves one end of an arrow with its end handle', () => {
    const { layer, container, onUpdate } = setup({ items: [arrow], selectedId: 'arrow-1', tool: 'select' });
    const handle = container.querySelector('[data-howbeam-edit-handle="to"]') as HTMLElement;
    fireEvent.pointerDown(handle, { clientX: 110, clientY: 190, button: 0 });
    fireEvent.pointerMove(layer, { clientX: 150, clientY: 170 });
    fireEvent.pointerUp(layer, { clientX: 150, clientY: 170 });
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ from: { x: 10, y: 150 }, to: { x: 150, y: 170 } }));
  });

  it('only offers width handles on text', () => {
    const { container } = setup({ items: [text], selectedId: 'text-1', tool: 'select' });
    const handles = [...container.querySelectorAll('[data-howbeam-edit-handle]')].map((element) => element.getAttribute('data-howbeam-edit-handle'));
    expect(handles.sort()).toEqual(['e', 'w']);
  });
});

describe('ImageEditLayer text', () => {
  it('starts editing text on a double press', () => {
    const { container, onStartTextEdit } = setup({ items: [text], tool: 'select' });
    fireEvent.pointerDown(chrome(container, 'text-1'), { clientX: 210, clientY: 110, button: 0, timeStamp: 1000 });
    fireEvent.pointerUp(container.querySelector('[data-howbeam-image-edit-layer]')!, { clientX: 150, clientY: 170 });
    fireEvent.pointerDown(chrome(container, 'text-1'), { clientX: 210, clientY: 110, button: 0, timeStamp: 1200 });
    expect(onStartTextEdit).toHaveBeenCalledWith('text-1');
  });

  it('starts editing on Enter and deletes on Delete', () => {
    const { container, onStartTextEdit, onDelete } = setup({ items: [text], selectedId: 'text-1', tool: 'select' });
    fireEvent.keyDown(chrome(container, 'text-1'), { key: 'Enter' });
    expect(onStartTextEdit).toHaveBeenCalledWith('text-1');
    fireEvent.keyDown(chrome(container, 'text-1'), { key: 'Delete' });
    expect(onDelete).toHaveBeenCalledWith('text-1');
  });

  it('commits typed text on Enter and cancels on Escape', () => {
    const editing = { ...(text as Extract<ImageEditItem, { kind: 'text' }>), text: 'Hi' };
    const first = setup({ items: [], editingText: editing, tool: 'select' });
    const area = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(area.value).toBe('Hi');
    fireEvent.change(area, { target: { value: 'Hello there' } });
    fireEvent.keyDown(area, { key: 'Enter' });
    expect(first.onFinishTextEdit).toHaveBeenCalledWith('Hello there');
    cleanup();

    const second = setup({ items: [], editingText: editing, tool: 'select' });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(second.onFinishTextEdit).toHaveBeenCalledWith(null);
  });

  it('limits text to what storage keeps and says so at the limit', () => {
    const editing = { ...(text as Extract<ImageEditItem, { kind: 'text' }>), text: 'Hi' };
    const { container } = setup({ items: [], editingText: editing, tool: 'select' });
    const area = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(area.maxLength).toBe(IMAGE_EDIT_LIMITS.maxTextLength);
    expect(container.querySelector('[data-howbeam-text-limit]')).toBeNull();
    fireEvent.input(area, { target: { value: 'x'.repeat(IMAGE_EDIT_LIMITS.maxTextLength) } });
    expect(container.querySelector('[data-howbeam-text-limit]')).toBeTruthy();
  });

  it('keeps Shift+Enter for a new line', () => {
    const editing = { ...(text as Extract<ImageEditItem, { kind: 'text' }>), text: 'Hi' };
    const { onFinishTextEdit } = setup({ items: [], editingText: editing, tool: 'select' });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: true });
    expect(onFinishTextEdit).not.toHaveBeenCalled();
  });
});

describe('ImageEditLayer keyboard and disabled state', () => {
  it('nudges a focused item', () => {
    const { container, onUpdate } = setup({ selectedId: 'mask-1' });
    fireEvent.keyDown(chrome(container, 'mask-1'), { key: 'ArrowRight', shiftKey: true });
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ bounds: { x: 110, y: 50, width: 80, height: 40 } }));
  });

  it('is inert while disabled', () => {
    const { layer, container, onCreate, onUpdate, onDelete } = setup({ disabled: true });
    fireEvent.pointerDown(layer, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerMove(layer, { clientX: 90, clientY: 90 });
    fireEvent.pointerUp(layer, { clientX: 90, clientY: 90 });
    fireEvent.keyDown(chrome(container, 'mask-1'), { key: 'Delete' });
    expect(onCreate).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe('ImageEditLayer crop', () => {
  const crop: ImageEditItem = { id: 'crop', kind: 'crop', bounds: { x: 100, y: 40, width: 200, height: 100 } };

  it('creates a crop from a drag with the crop tool', () => {
    const { layer, onCreate } = setup({ items: [], tool: 'crop' });
    fireEvent.pointerDown(layer, { clientX: 20, clientY: 20, button: 0 });
    fireEvent.pointerMove(layer, { clientX: 220, clientY: 120 });
    fireEvent.pointerUp(layer, { clientX: 220, clientY: 120 });
    expect(onCreate).toHaveBeenCalledWith({ id: 'crop', kind: 'crop', bounds: { x: 20, y: 20, width: 200, height: 100 } });
  });

  it('dims outside the crop at all times, but only lets the crop tool touch it', () => {
    const idle = setup({ items: [mask, crop], tool: 'select' });
    expect(idle.container.querySelector('[data-howbeam-crop-shade]')).toBeTruthy();
    expect(chrome(idle.container, 'crop').className).toContain('pointer-events-none');
    expect(chrome(idle.container, 'mask-1').className).not.toContain('pointer-events-none');
    cleanup();

    const modal = setup({ items: [mask, crop], tool: 'crop' });
    expect(chrome(modal.container, 'crop').className).not.toContain('pointer-events-none');
    expect(chrome(modal.container, 'mask-1').className).toContain('pointer-events-none');
    expect(modal.container.querySelectorAll('[data-howbeam-edit-handle]')).toHaveLength(8);
  });

  it('moves and resizes the crop with its handles', () => {
    const { layer, container, onUpdate } = setup({ items: [crop], tool: 'crop' });
    const handle = container.querySelector('[data-howbeam-edit-handle="se"]') as HTMLElement;
    fireEvent.pointerDown(handle, { clientX: 300, clientY: 140, button: 0 });
    fireEvent.pointerMove(layer, { clientX: 350, clientY: 160 });
    fireEvent.pointerUp(layer, { clientX: 350, clientY: 160 });
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'crop', bounds: { x: 100, y: 40, width: 250, height: 120 } }));
  });
});

