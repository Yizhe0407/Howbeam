// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HighlightThumbnail from '@/components/editor/HighlightThumbnail';
import { installThumbnailDomStubs, stubImageMetrics, type ThumbnailDomStubs } from '../setup/thumbnail-dom';
import { recordCanvasFills } from '../setup/canvas-paint';

describe('HighlightThumbnail', () => {
  let stubs: ThumbnailDomStubs;

  beforeEach(() => {
    stubs = installThumbnailDomStubs();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps full-viewport and corner frames inside a downscaled thumbnail', () => {
    const cases = [
      {
        name: 'full viewport',
        bounds: { x: 0, y: 0, width: 200, height: 100 },
        expectedEdges: { left: 0, top: 0, right: 100, bottom: 50 },
      },
      {
        name: 'top left',
        bounds: { x: 0, y: 0, width: 20, height: 16 },
        expectedEdges: { left: 0, top: 0 },
      },
      {
        name: 'top right',
        bounds: { x: 180, y: 0, width: 20, height: 16 },
        expectedEdges: { top: 0, right: 100 },
      },
      {
        name: 'bottom right',
        bounds: { x: 180, y: 84, width: 20, height: 16 },
        expectedEdges: { right: 100, bottom: 50 },
      },
      {
        name: 'bottom left',
        bounds: { x: 0, y: 84, width: 20, height: 16 },
        expectedEdges: { left: 0, bottom: 50 },
      },
    ];

    for (const { name, bounds, expectedEdges } of cases) {
      const view = render(
        <HighlightThumbnail
          blob={new Blob(['image'])}
          bounds={bounds}
          screenshotScale={1}
          alt={name}
          fit="contain"
        />,
      );
      const image = view.container.querySelector<HTMLImageElement>('img')!;
      stubImageMetrics(image, { naturalWidth: 200, naturalHeight: 100, rendered: { width: 100, height: 50 } });

      act(() => fireEvent.load(image));

      const overlay = view.container.querySelector<HTMLElement>('.pointer-events-none.absolute.box-border')!;
      const left = Number.parseFloat(overlay.style.left);
      const top = Number.parseFloat(overlay.style.top);
      const right = left + Number.parseFloat(overlay.style.width);
      const bottom = top + Number.parseFloat(overlay.style.height);

      expect(left, `${name} left`).toBeGreaterThanOrEqual(0);
      expect(top, `${name} top`).toBeGreaterThanOrEqual(0);
      expect(right, `${name} right`).toBeLessThanOrEqual(100);
      expect(bottom, `${name} bottom`).toBeLessThanOrEqual(50);
      if (expectedEdges.left !== undefined) expect(left, `${name} left edge`).toBe(expectedEdges.left);
      if (expectedEdges.top !== undefined) expect(top, `${name} top edge`).toBe(expectedEdges.top);
      if (expectedEdges.right !== undefined) expect(right, `${name} right edge`).toBe(expectedEdges.right);
      if (expectedEdges.bottom !== undefined) expect(bottom, `${name} bottom edge`).toBe(expectedEdges.bottom);

      view.unmount();
    }
  });

  it('anchors an overlay to the contained image pixels rather than its letterboxed box', () => {
    const view = render(
      <HighlightThumbnail
        blob={new Blob(['image'])}
        bounds={null}
        screenshotScale={1}
        alt="overlay preview"
        fit="contain"
        overlay={<span>點擊放大</span>}
      />,
    );
    const image = view.container.querySelector<HTMLImageElement>('img')!;
    stubImageMetrics(image, {
      naturalWidth: 200,
      naturalHeight: 100,
      offsetLeft: 10,
      offsetTop: 20,
      rendered: { width: 100, height: 100 },
    });

    act(() => fireEvent.load(image));

    const contentFrame = view.container.querySelector<HTMLElement>('[data-howbeam-image-content-frame]')!;
    expect(contentFrame.style.left).toBe('10px');
    expect(contentFrame.style.top).toBe('45px');
    expect(contentFrame.style.width).toBe('100px');
    expect(contentFrame.style.height).toBe('50px');
    expect(contentFrame.textContent).toBe('點擊放大');
  });

  // Redactions use the same CSS-coordinate-to-image mapping as highlights, but
  // render last so privacy masks always cover the annotation chrome beneath.
  it('maps opaque redactions from screenshot CSS coordinates above the highlight', () => {
    const fills = recordCanvasFills();
    const view = render(
      <HighlightThumbnail
        blob={new Blob(['image'])}
        bounds={{ x: 40, y: 10, width: 40, height: 20 }}
        redactions={[{ id: 'mask-1', kind: 'solid', bounds: { x: 50, y: 20, width: 30, height: 40 } }]}
        screenshotScale={1}
        alt="redacted preview"
        fit="contain"
      />,
    );
    const image = view.container.querySelector<HTMLImageElement>('img')!;
    stubImageMetrics(image, { naturalWidth: 200, naturalHeight: 100, rendered: { width: 100, height: 50 } });

    expect(image.style.visibility).toBe('hidden');
    expect(view.container.firstElementChild?.className).toContain('bg-black');

    act(() => fireEvent.load(image));
    expect(image.style.visibility).toBe('');

    const highlight = view.container.querySelector<HTMLElement>('.pointer-events-none.absolute.box-border')!;
    const layer = view.container.querySelector<HTMLElement>('[data-howbeam-redactions]')!;
    // The layer covers the image's pixels at the screenshot's own resolution; the mask is grown by its 2px safety margin.
    expect([layer.style.left, layer.style.top, layer.style.width, layer.style.height]).toEqual(['0px', '0px', '100px', '50px']);
    const canvas = layer.querySelector('canvas')!;
    expect([canvas.width, canvas.height]).toEqual([200, 100]);
    expect(fills).toEqual([{ rect: [48, 18, 34, 44], fill: '#000000' }]);
    expect(layer.className).toContain('z-10');
    expect(highlight.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('hides source pixels while a resize remaps a redaction overlay', () => {
    const view = render(
      <HighlightThumbnail
        blob={new Blob(['image'])}
        bounds={{ x: 10, y: 10, width: 30, height: 20 }}
        redactions={[{ id: 'mask-1', kind: 'solid', bounds: { x: 50, y: 20, width: 30, height: 40 } }]}
        screenshotScale={1}
        alt="resizing redacted preview"
        fit="contain"
      />,
    );
    const image = view.container.querySelector<HTMLImageElement>('img')!;
    stubImageMetrics(image, { naturalWidth: 200, naturalHeight: 100, rendered: { width: 100, height: 50 } });

    act(() => fireEvent.load(image));
    expect(image.style.visibility).toBe('');
    act(() => stubs.triggerResize());
    expect(image.style.visibility).toBe('hidden');
    act(() => stubs.flushAnimationFrames());
    expect(image.style.visibility).toBe('');
  });

  // Editing masks must not flicker: once the image is measured, a changed mask
  // list is applied in the same render, with the image never hidden and no
  // remap frame needed.
  it('applies added and moved redactions immediately without hiding the image', () => {
    const fills = recordCanvasFills();
    const redactionAt = (x: number) => [{ id: 'mask-1', kind: 'solid' as const, bounds: { x, y: 20, width: 30, height: 40 } }];
    const blob = new Blob(['image']);
    const view = render(
      <HighlightThumbnail
        blob={blob}
        bounds={null}
        redactions={redactionAt(50)}
        screenshotScale={1}
        alt="edited preview"
        fit="contain"
      />,
    );
    const image = view.container.querySelector<HTMLImageElement>('img')!;
    stubImageMetrics(image, { naturalWidth: 200, naturalHeight: 100, rendered: { width: 100, height: 50 } });
    act(() => fireEvent.load(image));
    act(() => stubs.flushAnimationFrames());
    expect(fills.map(({ rect }) => rect[0])).toEqual([48]);

    view.rerender(
      <HighlightThumbnail
        blob={blob}
        bounds={null}
        redactions={redactionAt(100)}
        screenshotScale={1}
        alt="edited preview"
        fit="contain"
      />,
    );

    expect(image.style.visibility).toBe('');
    expect(stubs.animationFrames.size).toBe(0);
    expect(fills.map(({ rect }) => rect[0])).toEqual([98]);
  });

  // When the image element is exactly the image's box (the zoomable editor), a
  // mask is a percentage of that box: resizing it can never separate mask and
  // pixels, so the image is never hidden and nothing is remeasured for masks.
  it('places masks as percentages in an exact box and survives resizes without hiding the image', () => {
    const fills = recordCanvasFills();
    const view = render(
      <HighlightThumbnail
        blob={new Blob(['image'])}
        bounds={null}
        redactions={[{ id: 'mask-1', kind: 'solid', bounds: { x: 50, y: 20, width: 30, height: 40 } }]}
        screenshotScale={1}
        alt="exact box"
        fit="contain"
        exactBox
      />,
    );
    const image = view.container.querySelector<HTMLImageElement>('img')!;
    stubImageMetrics(image, { naturalWidth: 200, naturalHeight: 100, rendered: { width: 400, height: 200 } });
    act(() => fireEvent.load(image));

    const layer = view.container.querySelector<HTMLElement>('[data-howbeam-redactions]')!;
    expect([layer.style.left, layer.style.top, layer.style.width, layer.style.height]).toEqual(['0px', '0px', '100%', '100%']);
    const mask = layer.querySelector('canvas')!;
    // The 2px safety margin around the mask is part of the box.
    expect(fills.map(({ rect }) => rect)).toEqual([[48, 18, 34, 44]]);

    act(() => stubs.triggerResize());
    expect(image.style.visibility).toBe('');
    expect(view.container.querySelector('[data-howbeam-redactions] canvas')).toBe(mask);
  });
});
