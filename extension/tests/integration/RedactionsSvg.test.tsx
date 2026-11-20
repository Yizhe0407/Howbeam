// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import RedactionsSvg from '@/components/editor/RedactionsSvg';
import type { Redaction } from '@/lib/storage/models';

afterEach(cleanup);

const stroke: Redaction = { id: 'stroke', kind: 'pixelate', points: [{ x: 10, y: 20 }, { x: 90, y: 20 }], size: 32 };
const box: Redaction = { id: 'box', kind: 'solid', bounds: { x: 5, y: 5, width: 10, height: 10 } };

describe('RedactionsSvg', () => {
  it('shows the mosaic through each stroke, the brush grown by the safety margin, in stored order', () => {
    const view = render(<RedactionsSvg redactions={[stroke, box]} width={200} height={100} mosaicUrl="blob:mosaic" />);
    const masks = Array.from(view.container.querySelectorAll('[data-howbeam-redaction]'));
    expect(masks.map((mask) => mask.getAttribute('data-howbeam-redaction'))).toEqual(['stroke', 'box']);

    const group = masks[0]!;
    const image = group.querySelector('image')!;
    expect(image.getAttribute('href')).toBe('blob:mosaic');
    expect([image.getAttribute('width'), image.getAttribute('height')]).toEqual(['200', '100']);
    const mask = group.querySelector('mask')!;
    expect(image.getAttribute('mask')).toBe(`url(#${mask.id})`);
    const path = mask.querySelector('path')!;
    expect(path.getAttribute('d')).toBe('M10 20L90 20');
    expect(path.getAttribute('stroke-width')).toBe('36');
    expect(path.getAttribute('stroke-linecap')).toBe('round');
    expect(mask.querySelector('circle')!.getAttribute('r')).toBe('18');
  });

  it('paints strokes solid black until the mosaic exists, so nothing shows through meanwhile', () => {
    const view = render(<RedactionsSvg redactions={[stroke]} width={200} height={100} mosaicUrl={null} />);
    const group = view.container.querySelector('[data-howbeam-redaction="stroke"]')!;
    expect(group.querySelector('image')).toBeNull();
    expect(group.querySelector('path')!.getAttribute('stroke')).toBe('#000000');
    expect(group.querySelector('circle')!.getAttribute('fill')).toBe('#000000');
  });
});
