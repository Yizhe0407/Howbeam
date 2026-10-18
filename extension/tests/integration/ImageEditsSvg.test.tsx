// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ImageEditsSvg from '@/components/editor/ImageEditsSvg';
import type { ImageEdit } from '@/lib/storage/image-edit-model';

afterEach(cleanup);

const edits: ImageEdit[] = [
  { id: 'rect-1', kind: 'rect', bounds: { x: 1, y: 2, width: 30, height: 40 }, width: 2, fill: 'none', color: '#ffc800' },
  { id: 'ellipse-1', kind: 'ellipse', bounds: { x: 3, y: 4, width: 30, height: 20 }, width: 4, fill: 'tint', color: '#22a559' },
  { id: 'arrow-1', kind: 'arrow', from: { x: 5, y: 6 }, to: { x: 80, y: 90 }, width: 4, color: '#ff4747' },
  { id: 'step-1', kind: 'step', center: { x: 12, y: 14 }, radius: 16, number: 3, color: '#a1b2c3' },
  { id: 'text-1', kind: 'text', bounds: { x: 10, y: 20, width: 200, height: 62.4 }, text: '點這裡\nClick here', fontSize: 24, look: 'plain', color: '#2f6fed' },
];

describe('ImageEditsSvg', () => {
  it('draws every edit kind in screenshot coordinates', () => {
    const { container } = render(<ImageEditsSvg edits={edits} width={400} height={200} />);
    const svg = container.querySelector('svg')!;

    expect(svg.getAttribute('viewBox')).toBe('0 0 400 200');
    expect(svg.querySelector('rect')!.getAttribute('fill')).toBe('none');
    expect(svg.querySelector('ellipse')!.getAttribute('fill')).not.toBe('none');
    expect(svg.querySelector('line')).not.toBeNull();
    expect(svg.querySelector('polygon')).not.toBeNull();
    expect(svg.querySelectorAll('circle')).toHaveLength(2);
    const texts = [...svg.querySelectorAll('text')].map((node) => node.textContent);
    expect(texts).toEqual(['3', '點這裡', 'Click here']);
  });

  it('draws nothing for an arrow too short to have a head', () => {
    const { container } = render(
      <ImageEditsSvg
        edits={[{ id: 'a', kind: 'arrow', from: { x: 5, y: 5 }, to: { x: 5, y: 5 }, width: 4, color: '#ff4747' }]}
        width={100}
        height={100}
      />,
    );

    expect(container.querySelector('svg')!.childElementCount).toBe(0);
  });
});
