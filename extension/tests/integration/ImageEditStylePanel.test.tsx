// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ImageEditStylePanel from '@/components/editor/ImageEditStylePanel';
import { DEFAULT_IMAGE_EDIT_STYLE } from '@/lib/editor/image-edit-style';

afterEach(cleanup);

function renderPanel(fields: Parameters<typeof ImageEditStylePanel>[0]['fields'], number?: number) {
  const onChange = vi.fn();
  render(<ImageEditStylePanel fields={fields} style={DEFAULT_IMAGE_EDIT_STYLE} number={number} onChange={onChange} />);
  return onChange;
}

describe('ImageEditStylePanel', () => {
  it('commits a typed marker number on Enter, clamped to the allowed range', () => {
    const onChange = renderPanel(['number'], 3);
    const field = screen.getByRole('textbox', { name: '編號' });

    fireEvent.change(field, { target: { value: '12' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith({ number: 12 });

    fireEvent.change(field, { target: { value: '0' } });
    fireEvent.blur(field);
    expect(onChange).toHaveBeenLastCalledWith({ number: 1 });
    expect(field).toHaveProperty('value', '1');

    fireEvent.change(field, { target: { value: 'abc' } });
    expect(field).toHaveProperty('value', '');
    fireEvent.blur(field);
    expect(field).toHaveProperty('value', '3');
  });

  it('steps the marker number with the arrow keys', () => {
    const onChange = renderPanel(['number'], 3);
    fireEvent.keyDown(screen.getByRole('textbox', { name: '編號' }), { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith({ number: 4 });
  });

  it('opens the custom colour picker and commits a typed hex once', () => {
    const onChange = renderPanel(['color']);
    fireEvent.click(screen.getByRole('button', { name: '自訂顏色' }));
    const hex = screen.getByRole('textbox', { name: '色碼' });

    fireEvent.change(hex, { target: { value: '12ab34' } });
    fireEvent.keyDown(hex, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ color: '#12ab34' });
    expect(screen.getByRole('slider', { name: '色相' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: '飽和度與亮度' })).toBeTruthy();
  });

  it('shows a picked colour as its own selected swatch, keeping the picker button', () => {
    const onChange = vi.fn();
    render(<ImageEditStylePanel fields={['color']} style={{ ...DEFAULT_IMAGE_EDIT_STYLE, color: '#8a2be2' }} onChange={onChange} />);
    expect(screen.getByRole('radio', { name: '#8a2be2' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: '自訂顏色' })).toBeTruthy();
  });

  it('moves the hue with the keyboard, one undo step per key', () => {
    const onChange = renderPanel(['color']);
    fireEvent.click(screen.getByRole('button', { name: '自訂顏色' }));
    const hue = screen.getByRole('slider', { name: '色相' });
    const before = Number(hue.getAttribute('aria-valuenow'));
    fireEvent.keyDown(hue, { key: 'ArrowRight', shiftKey: true });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(Number(hue.getAttribute('aria-valuenow'))).toBe(before + 10);
  });
});
