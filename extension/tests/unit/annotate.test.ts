import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/capture/raster-image-validation', () => ({
  validateRasterImageBlob: vi.fn().mockResolvedValue({ width: 100, height: 100, mediaType: 'image/png' }),
}));
import { BADGE_RADIUS, HIGHLIGHT_PADDING, LEADER_LINE_WIDTH, MARKER_RADIUS, REDACTION_COLOR, REDACTION_EXPANSION, type AnnotationLayout } from '@/lib/media/annotation-contract';
import { compositeHighlight, compositeMultiHighlight, getExpandedRedactionBounds } from '@/lib/media/annotation-composite';
import { distanceToBounds, getBadgeFontSize } from '@/lib/media/annotation-geometry';
import { layoutAnnotations, layoutWithProvisional } from '@/lib/media/annotation-layout';
import { itemAt } from '../setup/item-at';

interface Point {
  x: number;
  y: number;
}

function segmentsCross(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const orient = (p: Point, q: Point, r: Point) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const d1 = orient(b1, b2, a1);
  const d2 = orient(b1, b2, a2);
  const d3 = orient(a1, a2, b1);
  const d4 = orient(a1, a2, b2);
  return d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
}

function countLeaderCrossings(layouts: AnnotationLayout[]): number {
  const leaders = layouts.filter((layout) => layout.leader.length >= 2).map((layout) => layout.leader);
  let crossings = 0;
  for (let i = 0; i < leaders.length; i++) {
    for (let j = i + 1; j < leaders.length; j++) {
      for (let a = 1; a < itemAt(leaders, i).length; a++) {
        for (let b = 1; b < itemAt(leaders, j).length; b++) {
          if (segmentsCross(itemAt(itemAt(leaders, i), a - 1), itemAt(itemAt(leaders, i), a), itemAt(itemAt(leaders, j), b - 1), itemAt(itemAt(leaders, j), b))) crossings++;
        }
      }
    }
  }
  return crossings;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Positive-area overlap; edge-touching frames count as disjoint. */
function rectsOverlap(a: Rect, b: Rect): boolean {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0;
}

function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

function expectFiniteLayout(layout: AnnotationLayout): void {
  const values = [
    layout.frame.x,
    layout.frame.y,
    layout.frame.width,
    layout.frame.height,
    layout.anchor.x,
    layout.anchor.y,
    layout.badgeAnchor.x,
    layout.badgeAnchor.y,
    ...layout.leader.flatMap((point) => [point.x, point.y]),
  ];
  expect(values.every(Number.isFinite)).toBe(true);
}

function expectRectInsideViewport(rect: Rect, width: number, height: number): void {
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(width);
  expect(rect.y + rect.height).toBeLessThanOrEqual(height);
}

function expectCircleInsideViewport(point: Point, radius: number, width: number, height: number): void {
  expect(point.x - radius).toBeGreaterThanOrEqual(0);
  expect(point.y - radius).toBeGreaterThanOrEqual(0);
  expect(point.x + radius).toBeLessThanOrEqual(width);
  expect(point.y + radius).toBeLessThanOrEqual(height);
}

describe('layoutAnnotations', () => {
  it('keeps full-viewport, edge, and corner frames and badges inside the drawable viewport', () => {
    const viewportWidth = 320;
    const viewportHeight = 200;
    const cases: Rect[] = [
      { x: 0, y: 0, width: viewportWidth, height: viewportHeight },
      { x: 120, y: 0, width: 40, height: 24 },
      { x: viewportWidth - 40, y: 80, width: 40, height: 24 },
      { x: 120, y: viewportHeight - 24, width: 40, height: 24 },
      { x: 0, y: 80, width: 40, height: 24 },
      { x: 0, y: 0, width: 40, height: 24 },
      { x: viewportWidth - 40, y: 0, width: 40, height: 24 },
      { x: viewportWidth - 40, y: viewportHeight - 24, width: 40, height: 24 },
      { x: 0, y: viewportHeight - 24, width: 40, height: 24 },
    ];

    cases.forEach((bounds, index) => {
      const layout = itemAt(layoutAnnotations([{ bounds, order: index + 1 }], viewportWidth, viewportHeight), 0);

      expect(layout.markerOnly).toBe(false);
      expectRectInsideViewport(layout.frame, viewportWidth, viewportHeight);
      expectCircleInsideViewport(layout.badgeAnchor, BADGE_RADIUS, viewportWidth, viewportHeight);
    });

    expect(itemAt(layoutAnnotations([{ bounds: itemAt(cases, 0), order: 1 }], viewportWidth, viewportHeight), 0).frame).toEqual({
      x: 0,
      y: 0,
      width: viewportWidth,
      height: viewportHeight,
    });
  });

  it('keeps edge-adjacent sibling frames inside the viewport and pairwise disjoint', () => {
    const viewportWidth = 240;
    const viewportHeight = 160;
    const edgePairs: Rect[][] = [
      [
        { x: 20, y: 0, width: 28, height: 20 },
        { x: 49, y: 0, width: 28, height: 20 },
      ],
      [
        { x: viewportWidth - 77, y: viewportHeight - 20, width: 28, height: 20 },
        { x: viewportWidth - 48, y: viewportHeight - 20, width: 28, height: 20 },
      ],
      [
        { x: 0, y: 20, width: 20, height: 28 },
        { x: 0, y: 49, width: 20, height: 28 },
      ],
      [
        { x: viewportWidth - 20, y: viewportHeight - 77, width: 20, height: 28 },
        { x: viewportWidth - 20, y: viewportHeight - 48, width: 20, height: 28 },
      ],
    ];

    edgePairs.forEach((boundsPair) => {
      const layouts = layoutAnnotations(
        boundsPair.map((bounds, index) => ({ bounds, order: index + 1 })),
        viewportWidth,
        viewportHeight,
      );

      expect(layouts.every((layout) => !layout.markerOnly)).toBe(true);
      layouts.forEach((layout) => {
        expectRectInsideViewport(layout.frame, viewportWidth, viewportHeight);
        expectCircleInsideViewport(layout.badgeAnchor, BADGE_RADIUS, viewportWidth, viewportHeight);
      });
      expect(rectsOverlap(itemAt(layouts, 0).frame, itemAt(layouts, 1).frame)).toBe(false);
    });
  });

  it('keeps marker circles, callout badges, and stroked leaders inside all four edges and corners', () => {
    const viewportWidth = 240;
    const viewportHeight = 160;
    const targets: Rect[] = [
      { x: 0, y: 70, width: 4, height: 20 },
      { x: viewportWidth - 4, y: 70, width: 4, height: 20 },
      { x: 110, y: 0, width: 20, height: 4 },
      { x: 110, y: viewportHeight - 4, width: 20, height: 4 },
      { x: 0, y: 0, width: 4, height: 4 },
      { x: viewportWidth - 4, y: 0, width: 4, height: 4 },
      { x: viewportWidth - 4, y: viewportHeight - 4, width: 4, height: 4 },
      { x: 0, y: viewportHeight - 4, width: 4, height: 4 },
    ];

    targets.forEach((bounds, targetIndex) => {
      const layouts = layoutAnnotations(
        [
          { bounds, order: targetIndex * 2 + 1 },
          { bounds, order: targetIndex * 2 + 2 },
        ],
        viewportWidth,
        viewportHeight,
      );

      expect(layouts.every((layout) => layout.markerOnly && layout.callout !== null)).toBe(true);
      expect(layouts.some((layout) => layout.leader.length === 2)).toBe(true);
      layouts.forEach((layout) => {
        expectCircleInsideViewport(layout.anchor, MARKER_RADIUS, viewportWidth, viewportHeight);
        expectCircleInsideViewport(layout.callout!, BADGE_RADIUS, viewportWidth, viewportHeight);
        expectRectInsideViewport(layout.frame, viewportWidth, viewportHeight);
        layout.leader.forEach((point) => {
          expectCircleInsideViewport(point, LEADER_LINE_WIDTH / 2, viewportWidth, viewportHeight);
        });
      });
    });
  });

  it('lays out 1,000 dispersed targets with finite, viewport-contained badges', () => {
    const annotations = Array.from({ length: 1_000 }, (_, index) => ({
      bounds: {
        x: 20 + (index % 40) * 30,
        y: 20 + Math.floor(index / 40) * 30,
        width: 14,
        height: 10,
      },
      order: index + 1,
    }));

    const layouts = layoutAnnotations(annotations, 1_280, 800);

    expect(layouts).toHaveLength(1_000);
    expect(layouts.every((layout) => !layout.markerOnly)).toBe(true);
    for (const layout of layouts) {
      expectFiniteLayout(layout);
      expect(layout.badgeAnchor.x).toBeGreaterThanOrEqual(BADGE_RADIUS);
      expect(layout.badgeAnchor.x).toBeLessThanOrEqual(1_280 - BADGE_RADIUS);
      expect(layout.badgeAnchor.y).toBeGreaterThanOrEqual(BADGE_RADIUS);
      expect(layout.badgeAnchor.y).toBeLessThanOrEqual(800 - BADGE_RADIUS);
    }
  }, 10_000);

  it('spreads 1,000 coincident targets across multiple collision-free lanes', () => {
    const annotations = Array.from({ length: 1_000 }, (_, index) => ({
      bounds: { x: 100, y: 100, width: 80, height: 32 },
      order: index + 1,
    }));

    const layouts = layoutAnnotations(annotations, 1_280, 720);
    const badgeKeys = new Set(layouts.map((layout) => `${layout.badgeAnchor.x}:${layout.badgeAnchor.y}`));

    expect(layouts).toHaveLength(1_000);
    expect(layouts.every((layout) => layout.markerOnly && layout.callout !== null)).toBe(true);
    expect(badgeKeys.size).toBe(1_000);
    for (const layout of layouts) {
      expectFiniteLayout(layout);
      expect(layout.badgeAnchor.x).toBeGreaterThanOrEqual(BADGE_RADIUS);
      expect(layout.badgeAnchor.x).toBeLessThanOrEqual(1_280 - BADGE_RADIUS);
      expect(layout.badgeAnchor.y).toBeGreaterThanOrEqual(BADGE_RADIUS);
      expect(layout.badgeAnchor.y).toBeLessThanOrEqual(720 - BADGE_RADIUS);
    }
  }, 10_000);

  it('uses the uncongested axis for a long vertical list', () => {
    const annotations = Array.from({ length: 1_000 }, (_, index) => ({
      bounds: { x: 40, y: 20 + index * 24, width: 120, height: 10 },
      order: index + 1,
    }));

    const layouts = layoutAnnotations(annotations, 800, 24_100);

    expect(layouts).toHaveLength(1_000);
    layouts.forEach(expectFiniteLayout);
  }, 10_000);

  it('indexes viewport-sized obstacles without materializing every grid cell', () => {
    const viewportSize = 1_000_000;
    const layouts = layoutAnnotations(
      [
        { bounds: { x: 0, y: 0, width: viewportSize, height: viewportSize }, order: 1 },
        { bounds: { x: 200, y: 200, width: 80, height: 32 }, order: 2 },
      ],
      viewportSize,
      viewportSize,
    );

    expect(layouts).toHaveLength(2);
    layouts.forEach(expectFiniteLayout);
  });

  it('moves a badge off a provisional target without turning it into a group member', () => {
    const search = { x: 648, y: 113, width: 334, height: 64 };
    const icon = { x: 1000, y: 113, width: 55, height: 64 };
    const committedOnly = layoutWithProvisional([{ bounds: search, order: 6 }], 1_920, 1_080, null);
    const withHover = layoutWithProvisional([{ bounds: search, order: 6 }], 1_920, 1_080, icon);
    const committedBoth = layoutAnnotations(
      [{ bounds: search, order: 6 }, { bounds: icon, order: 7 }],
      1_920,
      1_080,
    );

    expect(distanceToBounds(itemAt(committedOnly.layouts, 0).badgeAnchor, itemAt(committedBoth, 1).frame)).toBeLessThan(15);
    expect(distanceToBounds(itemAt(withHover.layouts, 0).badgeAnchor, withHover.provisionalFrame!)).toBeGreaterThanOrEqual(15);
    expect(withHover.layouts).toHaveLength(1);
    expect(itemAt(withHover.layouts, 0).markerOnly).toBe(false);
    expect(itemAt(withHover.layouts, 0).badgeAnchor).toEqual(itemAt(committedBoth, 0).badgeAnchor);
    expect(withHover.provisionalFrame).toEqual(itemAt(committedBoth, 1).frame);
  });

  it('keeps a committed target framed when the provisional one coincides with it', () => {
    const bounds = { x: 300, y: 200, width: 120, height: 40 };
    const { layouts, provisionalFrame } = layoutWithProvisional(
      [{ bounds, order: 1 }],
      1_280,
      800,
      { ...bounds, x: bounds.x + 10 },
    );

    expect(layouts).toHaveLength(1);
    expect(itemAt(layouts, 0).markerOnly).toBe(false);
    expect(provisionalFrame).not.toBeNull();
  });

  it('routes a horizontal cluster to a horizontal lane in step order without leader crossings', () => {
    // Toolbar-like targets overlapping enough to chain-merge into one coincident group.
    const annotations = Array.from({ length: 14 }, (_, index) => ({
      bounds: { x: 200 + index * 18, y: 100, width: 32, height: 32 },
      order: index + 1,
    }));

    const layouts = layoutAnnotations(annotations, 1_280, 800);

    expect(layouts.every((layout) => layout.markerOnly && layout.callout !== null)).toBe(true);
    const badgeYs = new Set(layouts.map((layout) => layout.callout!.y));
    expect(badgeYs.size).toBe(1);
    const sortedByBadgeX = layouts.slice().sort((a, b) => a.callout!.x - b.callout!.x);
    expect(sortedByBadgeX.map((layout) => layout.order)).toEqual(annotations.map((a) => a.order));
    expect(countLeaderCrossings(layouts)).toBe(0);
  });

  it('routes a vertical stack to a side lane without leader crossings', () => {
    const annotations = Array.from({ length: 12 }, (_, index) => ({
      bounds: { x: 400, y: 200 + index * 14, width: 220, height: 28 },
      order: index + 1,
    }));

    const layouts = layoutAnnotations(annotations, 1_280, 800);

    expect(layouts.every((layout) => layout.markerOnly && layout.callout !== null)).toBe(true);
    const badgeXs = new Set(layouts.map((layout) => layout.callout!.x));
    expect(badgeXs.size).toBe(1);
    const sortedByBadgeY = layouts.slice().sort((a, b) => a.callout!.y - b.callout!.y);
    expect(sortedByBadgeY.map((layout) => layout.order)).toEqual(annotations.map((a) => a.order));
    expect(countLeaderCrossings(layouts)).toBe(0);
  });

  it('keeps a jittered coincident cluster in step-number order down the lane', () => {
    // Anchors differ by less than a marker diameter, so lane order must follow step numbers, not jitter.
    const annotations = Array.from({ length: 10 }, (_, index) => ({
      bounds: { x: 500 + (index % 3) * 8, y: 300 + (index % 4) * 6, width: 120, height: 32 },
      order: index + 1,
    }));

    const layouts = layoutAnnotations(annotations, 1_280, 800);

    const sortedByBadgeY = layouts.slice().sort((a, b) => a.callout!.y - b.callout!.y);
    expect(sortedByBadgeY.map((layout) => layout.order)).toEqual(annotations.map((a) => a.order));
    // Crossings aren't asserted: step order is preferred over jitter order even though
    // that can cross within the sub-marker-sized anchor blob.
  });

  it('keeps a page-sized container from gluing scattered targets into one group', () => {
    // Containment (a near-fullscreen container) is not coincidence: every target
    // stays a framed single, no markers or page-crossing leaders.
    const annotations = [
      { bounds: { x: 4, y: 60, width: 1270, height: 730 }, order: 1 },
      ...Array.from({ length: 8 }, (_, index) => ({
        bounds: { x: 150 + index * 140, y: 200 + (index % 4) * 130, width: 60, height: 22 },
        order: index + 2,
      })),
    ];

    const layouts = layoutAnnotations(annotations, 1_280, 800);

    expect(layouts.every((layout) => !layout.markerOnly && layout.callout === null)).toBe(true);
    expect(layouts.every((layout) => layout.leader.length === 0)).toBe(true);
  });

  it('keeps every framed single disjoint in a tight grid of close but separate targets', () => {
    // Small targets packed with 1-9px gaps; none overlap, so all stay framed
    // singles with disjoint padded frames.
    const annotations: { bounds: Rect; order: number }[] = [];
    let order = 1;
    let y = 60;
    for (let row = 0; row < 7; row++) {
      let x = 60;
      for (let column = 0; column < 7; column++) {
        annotations.push({ bounds: { x, y, width: 24, height: 18 }, order: order++ });
        x += 24 + (1 + (column % 5) * 2);
      }
      y += 18 + (1 + (row % 5) * 2);
    }

    const layouts = layoutAnnotations(annotations, 1_280, 800);
    const frames = layouts.filter((layout) => !layout.markerOnly).map((layout) => layout.frame);

    expect(frames).toHaveLength(annotations.length);
    for (let i = 0; i < frames.length; i++) {
      for (let j = i + 1; j < frames.length; j++) {
        expect(rectsOverlap(itemAt(frames, i), itemAt(frames, j))).toBe(false);
      }
    }
  });

  it('splits partially overlapping sibling hit areas into disjoint frames', () => {
    const layouts = layoutAnnotations(
      [
        { bounds: { x: 100, y: 80, width: 64, height: 48 }, order: 1 },
        { bounds: { x: 150, y: 80, width: 64, height: 48 }, order: 2 },
        { bounds: { x: 200, y: 80, width: 64, height: 48 }, order: 3 },
      ],
      800,
      600,
    );

    expect(layouts.every((layout) => !layout.markerOnly)).toBe(true);
    for (let index = 1; index < layouts.length; index++) {
      expect(rectsOverlap(itemAt(layouts, index - 1).frame, itemAt(layouts, index).frame)).toBe(false);
      expect(itemAt(layouts, index - 1).frame.x + itemAt(layouts, index - 1).frame.width)
        .toBeLessThan(itemAt(layouts, index).frame.x);
    }
  });

  it('splits vertically overlapping sibling hit areas without affecting outer sides', () => {
    const layouts = layoutAnnotations(
      [
        { bounds: { x: 100, y: 80, width: 56, height: 64 }, order: 1 },
        { bounds: { x: 100, y: 130, width: 56, height: 64 }, order: 2 },
      ],
      800,
      600,
    );

    expect(rectsOverlap(itemAt(layouts, 0).frame, itemAt(layouts, 1).frame)).toBe(false);
    expect(itemAt(layouts, 0).frame.y + itemAt(layouts, 0).frame.height).toBeLessThan(itemAt(layouts, 1).frame.y);
    expect(itemAt(layouts, 0).frame.x).toBe(100 - HIGHLIGHT_PADDING);
    expect(itemAt(layouts, 1).frame.x).toBe(100 - HIGHLIGHT_PADDING);
  });

  it('keeps a nested inner frame inside the container raw bounds', () => {
    // A big container with a small element near its edge; containment isn't
    // coincidence, so both stay framed singles and must nest correctly.
    const outerRaw = { x: 100, y: 100, width: 600, height: 400 };
    const innerRaw = { x: 108, y: 108, width: 120, height: 40 };
    const layouts = layoutAnnotations(
      [
        { bounds: outerRaw, order: 1 },
        { bounds: innerRaw, order: 2 },
      ],
      1_280,
      800,
    );

    expect(layouts.every((layout) => !layout.markerOnly)).toBe(true);
    const outerFrame = layouts.find((layout) => layout.order === 1)!.frame;
    const innerFrame = layouts.find((layout) => layout.order === 2)!.frame;

    expect(rectContains(outerRaw, innerFrame)).toBe(true);
    expect(rectContains(outerFrame, innerFrame)).toBe(true);
  });

  it('still merges duplicate clicks on the same-sized target', () => {
    const layouts = layoutAnnotations(
      [
        { bounds: { x: 100, y: 100, width: 80, height: 32 }, order: 1 },
        { bounds: { x: 104, y: 102, width: 80, height: 32 }, order: 2 },
      ],
      1_280,
      800,
    );

    expect(layouts.every((layout) => layout.markerOnly && layout.callout !== null)).toBe(true);
  });

  it('keeps geometry finite when the viewport is smaller than one badge', () => {
    const layouts = layoutAnnotations(
      [
        { bounds: { x: 1, y: 1, width: 4, height: 3 }, order: 1 },
        { bounds: { x: 1, y: 1, width: 4, height: 3 }, order: 2 },
      ],
      10,
      8,
    );

    expect(layouts).toHaveLength(2);
    layouts.forEach(expectFiniteLayout);
    expect(layouts.map((layout) => layout.badgeAnchor)).toEqual([
      { x: 5, y: 4 },
      { x: 5, y: 4 },
    ]);
  });

  it('shrinks four-digit labels while retaining the normal one-digit size', () => {
    expect(getBadgeFontSize(1)).toBe(BADGE_RADIUS * 2 * 0.55);
    expect(getBadgeFontSize(1_000)).toBeLessThan(getBadgeFontSize(99));
    expect(getBadgeFontSize(1_000)).toBeGreaterThanOrEqual(7);
  });
});


describe('raster redactions', () => {
  it('expands each mask by two CSS pixels and clips it to the screenshot viewport', () => {
    expect(REDACTION_EXPANSION).toBe(2);
    expect(getExpandedRedactionBounds({ x: 10, y: 20, width: 30, height: 40 }, 100, 100)).toEqual({
      x: 8,
      y: 18,
      width: 34,
      height: 44,
    });
    expect(getExpandedRedactionBounds({ x: -5, y: 96, width: 20, height: 10 }, 100, 100)).toEqual({
      x: 0,
      y: 94,
      width: 17,
      height: 6,
    });
    expect(getExpandedRedactionBounds({ x: 120, y: 10, width: 4, height: 4 }, 100, 100)).toBeNull();
  });

  it('draws opaque redactions after annotation strokes in bitmap coordinates', async () => {
    const calls: Array<[string, ...number[]]> = [];
    const context = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      drawImage: () => calls.push(['drawImage']),
      beginPath: () => calls.push(['beginPath']),
      roundRect: (...args: number[]) => calls.push(['roundRect', ...args]),
      fill: () => calls.push(['fill']),
      stroke: () => calls.push(['stroke']),
      fillRect: (...args: number[]) => calls.push(['fillRect', ...args]),
    };
    class FakeOffscreenCanvas {
      constructor(_width: number, _height: number) {}
      getContext() {
        return context;
      }
      convertToBlob() {
        calls.push(['convertToBlob']);
        return Promise.resolve(new Blob(['rendered'], { type: 'image/png' }));
      }
    }
    const close = vi.fn();
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 200, height: 100, close })));

    try {
      await compositeHighlight(
        new Blob(['source']),
        { x: 20, y: 10, width: 30, height: 20 },
        2,
        'image/png',
        [{ id: 'mask', kind: 'solid', bounds: { x: 98, y: 48, width: 10, height: 10 } }],
      );

      expect(context.fillStyle).toBe(REDACTION_COLOR);
      expect(calls).toContainEqual(['fillRect', 192, 92, 8, 8]);
      expect(calls.findIndex(([name]) => name === 'fillRect')).toBeGreaterThan(calls.findIndex(([name]) => name === 'stroke'));
      expect(calls.at(-1)).toEqual(['convertToBlob']);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('passes an untouched screenshot through without decoding when nothing must be drawn', async () => {
    // No canvas globals stubbed: reaching createImageBitmap/OffscreenCanvas would
    // throw, so success proves the decode/encode round trip was skipped.
    const screenshot = new Blob(['source'], { type: 'image/png' });

    const result = await compositeHighlight(screenshot, null, 2, 'image/png');

    expect(result).toBe(screenshot);
  });

  it('still composites when a redaction, privacy block, or format conversion applies', async () => {
    const context = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      drawImage: vi.fn(),
      fillRect: vi.fn(),
    };
    class FakeOffscreenCanvas {
      constructor(_width: number, _height: number) {}
      getContext() {
        return context;
      }
      convertToBlob() {
        return Promise.resolve(new Blob(['rendered'], { type: 'image/png' }));
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 200, height: 100, close: vi.fn() })));

    try {
      const screenshot = new Blob(['source'], { type: 'image/png' });
      const masked = await compositeHighlight(screenshot, null, 2, 'image/png', [
        { id: 'mask', kind: 'solid', bounds: { x: 10, y: 10, width: 20, height: 10 } },
      ]);
      expect(masked).not.toBe(screenshot);
      expect(context.fillRect).toHaveBeenCalled();

      // Privacy review must stay fail-closed even with nothing else to draw.
      const blocked = await compositeHighlight(screenshot, null, 2, 'image/png', [], true);
      expect(blocked).not.toBe(screenshot);

      // Validated media type (mocked image/png) differs from the requested
      // format, so it must be transcoded, not reused.
      const transcoded = await compositeHighlight(screenshot, null, 2, 'image/jpeg');
      expect(transcoded).not.toBe(screenshot);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('skips stroking a degenerate frame clamped to the viewport edge', async () => {
    const calls: string[] = [];
    const context = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      drawImage: () => calls.push('drawImage'),
      beginPath: () => calls.push('beginPath'),
      roundRect: () => calls.push('roundRect'),
      fill: () => calls.push('fill'),
      stroke: () => calls.push('stroke'),
      fillRect: () => calls.push('fillRect'),
    };
    class FakeOffscreenCanvas {
      constructor(_width: number, _height: number) {}
      getContext() {
        return context;
      }
      convertToBlob() {
        return Promise.resolve(new Blob(['rendered'], { type: 'image/png' }));
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 200, height: 100, close: vi.fn() })));

    try {
      // Bounds beyond the 100x50 viewport's right edge clamp to a zero-width
      // frame that must not paint an edge hairline.
      await compositeHighlight(new Blob(['source']), { x: 150, y: 20, width: 30, height: 20 }, 2, 'image/png');

      expect(calls).toEqual(['drawImage']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('compositeMultiHighlight', () => {
  /** Records every context call by name so ordering invariants are checkable. */
  function fakeCanvas() {
    const calls: Array<[string, ...unknown[]]> = [];
    const record = (name: string) => (...args: unknown[]) => calls.push([name, ...args]);
    const context = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      lineCap: '',
      lineJoin: '',
      font: '',
      textAlign: '',
      textBaseline: '',
      shadowColor: '',
      shadowBlur: 0,
      shadowOffsetY: 0,
      drawImage: record('drawImage'),
      beginPath: record('beginPath'),
      roundRect: record('roundRect'),
      fill: record('fill'),
      stroke: record('stroke'),
      fillRect: record('fillRect'),
      arc: record('arc'),
      moveTo: record('moveTo'),
      lineTo: record('lineTo'),
      save: record('save'),
      restore: record('restore'),
      fillText: record('fillText'),
      measureText: () => ({ width: 8, actualBoundingBoxAscent: 6, actualBoundingBoxDescent: 0 }),
    };
    class FakeOffscreenCanvas {
      constructor(_width: number, _height: number) {}
      getContext() {
        return context;
      }
      convertToBlob() {
        calls.push(['convertToBlob']);
        return Promise.resolve(new Blob(['rendered'], { type: 'image/png' }));
      }
    }
    return { calls, context, FakeOffscreenCanvas };
  }

  function stubBitmap(width: number, height: number, FakeOffscreenCanvas: unknown) {
    const close = vi.fn();
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width, height, close })));
    return close;
  }

  it('draws numbered frames and badges before privacy redactions', async () => {
    const { calls, context, FakeOffscreenCanvas } = fakeCanvas();
    const close = stubBitmap(400, 200, FakeOffscreenCanvas);

    try {
      await compositeMultiHighlight(
        new Blob(['source']),
        [
          { bounds: { x: 10, y: 10, width: 60, height: 20 }, order: 1 },
          { bounds: { x: 120, y: 60, width: 60, height: 20 }, order: 2 },
        ],
        2,
        'image/png',
        [{ id: 'mask', kind: 'solid', bounds: { x: 98, y: 48, width: 10, height: 10 } }],
      );

      expect(calls.filter(([name]) => name === 'roundRect')).toHaveLength(4);
      expect(calls.filter(([name]) => name === 'arc')).toHaveLength(2);
      const digits = calls.filter(([name]) => name === 'fillText').map(([, text]) => text);
      expect(digits).toEqual(['1', '2']);

      // Redactions must land after every annotation stroke, badge, and digit.
      const redactionIndex = calls.findIndex(([name]) => name === 'fillRect');
      expect(redactionIndex).toBeGreaterThan(calls.map(([name]) => name).lastIndexOf('stroke'));
      expect(redactionIndex).toBeGreaterThan(calls.map(([name]) => name).lastIndexOf('arc'));
      expect(redactionIndex).toBeGreaterThan(calls.map(([name]) => name).lastIndexOf('fillText'));
      expect(calls[redactionIndex]).toEqual(['fillRect', 192, 92, 28, 28]);
      expect(context.fillStyle).toBe(REDACTION_COLOR);
      expect(calls.at(-1)).toEqual(['convertToBlob']);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });


  it('renders coincident targets as markers with leaders and callout badges', async () => {
    const { calls, FakeOffscreenCanvas } = fakeCanvas();
    stubBitmap(1_280, 800, FakeOffscreenCanvas);

    try {
      await compositeMultiHighlight(
        new Blob(['source']),
        [
          { bounds: { x: 100, y: 100, width: 80, height: 32 }, order: 1 },
          { bounds: { x: 104, y: 102, width: 80, height: 32 }, order: 2 },
        ],
        1,
      );

      expect(calls.filter(([name]) => name === 'arc')).toHaveLength(2 * 3 + 2);
      expect(calls.filter(([name]) => name === 'fillText').map(([, text]) => text)).toEqual(['1', '2']);
      expect(calls.some(([name]) => name === 'moveTo')).toBe(true);
      expect(calls.some(([name]) => name === 'lineTo')).toBe(true);
      expect(calls.some(([name]) => name === 'roundRect')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('skips stroking annotations whose frames degenerate outside the viewport', async () => {
    const { calls, FakeOffscreenCanvas } = fakeCanvas();
    stubBitmap(200, 100, FakeOffscreenCanvas);

    try {
      await compositeMultiHighlight(
        new Blob(['source']),
        [{ bounds: { x: 150, y: 20, width: 30, height: 10 }, order: 1 }],
        2,
        'image/png',
      );

      // Only its badge is drawn; the frame itself is never stroked.
      expect(calls.some(([name]) => name === 'roundRect')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
