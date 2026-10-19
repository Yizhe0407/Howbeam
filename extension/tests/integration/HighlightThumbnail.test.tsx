// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HighlightThumbnail from '@/components/editor/HighlightThumbnail';
import { installThumbnailDomStubs, stubImageMetrics, type ThumbnailDomStubs } from '../setup/thumbnail-dom';

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
    const view = render(
      <HighlightThumbnail
        blob={new Blob(['image'])}
        bounds={{ x: 40, y: 10, width: 40, height: 20 }}
        redactions={[{ id: 'mask-1', kind: 'solid', bounds: { x: 50, y: 20, width: 30, height: 40 } }]}
        liveMasks
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
    const redaction = view.container.querySelector<HTMLElement>('[data-howbeam-redaction="mask-1"]')!;
    expect(redaction.style.left).toBe('24px');
    expect(redaction.style.top).toBe('9px');
    expect(redaction.style.width).toBe('17px');
    expect(redaction.style.height).toBe('22px');
    expect(redaction.style.backgroundColor).toBe('rgb(0, 0, 0)');
    expect(redaction.className).toContain('z-10');
    expect(highlight.compareDocumentPosition(redaction) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('hides source pixels while a resize remaps a redaction overlay', () => {
    const view = render(
      <HighlightThumbnail
        blob={new Blob(['image'])}
        bounds={{ x: 10, y: 10, width: 30, height: 20 }}
        redactions={[{ id: 'mask-1', kind: 'solid', bounds: { x: 50, y: 20, width: 30, height: 40 } }]}
        liveMasks
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
    const redactionAt = (x: number) => [{ id: 'mask-1', kind: 'solid' as const, bounds: { x, y: 20, width: 30, height: 40 } }];
    const blob = new Blob(['image']);
    const view = render(
      <HighlightThumbnail
        blob={blob}
        bounds={null}
        redactions={redactionAt(50)}
        liveMasks
        screenshotScale={1}
        alt="edited preview"
        fit="contain"
      />,
    );
    const image = view.container.querySelector<HTMLImageElement>('img')!;
    stubImageMetrics(image, { naturalWidth: 200, naturalHeight: 100, rendered: { width: 100, height: 50 } });
    act(() => fireEvent.load(image));
    act(() => stubs.flushAnimationFrames());
    const initialLeft = view.container.querySelector<HTMLElement>('[data-howbeam-redaction="mask-1"]')!.style.left;

    view.rerender(
      <HighlightThumbnail
        blob={blob}
        bounds={null}
        redactions={redactionAt(100)}
        liveMasks
        screenshotScale={1}
        alt="edited preview"
        fit="contain"
      />,
    );

    expect(image.style.visibility).toBe('');
    expect(stubs.animationFrames.size).toBe(0);
    expect(view.container.querySelector<HTMLElement>('[data-howbeam-redaction="mask-1"]')!.style.left).not.toBe(initialLeft);
  });

  // When the image element is exactly the image's box (the zoomable editor), a
  // mask is a percentage of that box: resizing it can never separate mask and
  // pixels, so the image is never hidden and nothing is remeasured for masks.
  it('places masks as percentages in an exact box and survives resizes without hiding the image', () => {
    const view = render(
      <HighlightThumbnail
        blob={new Blob(['image'])}
        bounds={null}
        redactions={[{ id: 'mask-1', kind: 'solid', bounds: { x: 50, y: 20, width: 30, height: 40 } }]}
        liveMasks
        screenshotScale={1}
        alt="exact box"
        fit="contain"
        exactBox
      />,
    );
    const image = view.container.querySelector<HTMLImageElement>('img')!;
    stubImageMetrics(image, { naturalWidth: 200, naturalHeight: 100, rendered: { width: 400, height: 200 } });
    act(() => fireEvent.load(image));

    const mask = view.container.querySelector<HTMLElement>('[data-howbeam-redaction="mask-1"]')!;
    // The 2px safety margin around the mask is part of the box: (50-2)/200, (20-2)/100, (30+4)/200, (40+4)/100.
    expect(mask.style.left).toBe('24%');
    expect(mask.style.top).toBe('18%');
    expect(mask.style.width).toBe('17%');
    expect(mask.style.height).toBe('44%');

    act(() => stubs.triggerResize());
    expect(image.style.visibility).toBe('');
    expect(view.container.querySelector('[data-howbeam-redaction="mask-1"]')).toBe(mask);
  });
});
