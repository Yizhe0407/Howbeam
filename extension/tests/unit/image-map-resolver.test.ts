// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  findImageForArea,
  findMapForImage,
  parseImageMapCoordinates,
  resolveImageMapTargetAtPoint,
} from '@/lib/recording/image-map-resolver';

interface FixtureOptions {
  shape?: string | null;
  coords?: string;
  mapName?: string;
  useMap?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

function defineMetric(image: HTMLImageElement, name: string, value: number): void {
  Object.defineProperty(image, name, { configurable: true, value });
}

function createFixture({
  shape = 'rect',
  coords = '10,10,40,40',
  mapName = 'diagram',
  useMap = '#diagram',
  x = 100,
  y = 50,
  width = 200,
  height = 100,
}: FixtureOptions = {}) {
  const image = document.createElement('img');
  image.setAttribute('usemap', useMap);
  defineMetric(image, 'offsetWidth', width);
  defineMetric(image, 'offsetHeight', height);
  defineMetric(image, 'naturalWidth', 1_000);
  defineMetric(image, 'naturalHeight', 500);
  const rect = {
    x,
    y,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
  image.getBoundingClientRect = () => rect;
  Object.defineProperty(image, 'getClientRects', {
    configurable: true,
    value: () => [rect],
  });

  const map = document.createElement('map');
  map.setAttribute('name', mapName);
  const area = document.createElement('area');
  area.href = '#target';
  if (shape !== null) area.setAttribute('shape', shape);
  area.coords = coords;
  map.append(area);
  document.body.append(image, map);
  return { image, map, area };
}

function appendDefaultArea(map: HTMLMapElement, href = '#fallback'): HTMLAreaElement {
  const area = document.createElement('area');
  area.href = href;
  area.shape = 'default';
  map.append(area);
  return area;
}

afterEach(() => document.body.replaceChildren());

describe('parseImageMapCoordinates', () => {
  it('accepts mixed commas, semicolons, and ASCII whitespace delimiters', () => {
    expect(parseImageMapCoordinates('10, 20\t30\n40\f50\r60;70')).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  it('follows HTML number-list recovery for garbage and non-finite values', () => {
    expect(parseImageMapCoordinates('x10, nope, -0, 1e9999')).toEqual([10, 0, 0, 0]);
  });
});

describe('image map association', () => {
  it('uses one exact, case-sensitive hash-name comparison in both directions', () => {
    const { image, map, area } = createFixture({ mapName: 'DiagramMap', useMap: '#DiagramMap' });

    expect(findMapForImage(image)).toBe(map);
    expect(findImageForArea(area)).toBe(image);

    image.setAttribute('usemap', '#diagrammap');
    expect(findMapForImage(image)).toBeNull();
    expect(findImageForArea(area)).toBeNull();
  });

  it('parses the first hash and matches either map id or name', () => {
    const { image, map, area } = createFixture({ mapName: 'legacy-name', useMap: 'page.html#ById' });
    map.id = 'ById';

    expect(findMapForImage(image)).toBe(map);
    expect(findImageForArea(area)).toBe(image);

    image.setAttribute('usemap', 'ById');
    expect(findMapForImage(image)).toBeNull();
    image.setAttribute('usemap', '#');
    expect(findMapForImage(image)).toBeNull();
  });

  it('uses the first matching map in tree order', () => {
    const first = createFixture({ mapName: 'shared', useMap: '#shared' });
    const duplicateMap = document.createElement('map');
    duplicateMap.name = 'shared';
    const duplicateArea = document.createElement('area');
    duplicateArea.href = '#duplicate';
    duplicateMap.append(duplicateArea);
    document.body.append(duplicateMap);

    expect(findMapForImage(first.image)).toBe(first.map);
    expect(findImageForArea(duplicateArea)).toBeNull();
  });

  it('uses the hit point to disambiguate multiple images sharing one map', () => {
    const { image: firstImage, map, area } = createFixture();
    const secondImage = document.createElement('img');
    secondImage.setAttribute('usemap', '#diagram');
    defineMetric(secondImage, 'offsetWidth', 200);
    defineMetric(secondImage, 'offsetHeight', 100);
    secondImage.getBoundingClientRect = () => ({ left: 400, top: 50, width: 200, height: 100 }) as DOMRect;
    document.body.insertBefore(secondImage, map);

    expect(findImageForArea(area)).toBe(firstImage);
    expect(findImageForArea(area, 425, 75)).toBe(secondImage);
  });

  it('keeps image and map lookup within their shared tree', () => {
    const { image, map, area } = createFixture();
    const host = document.createElement('div');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    document.body.append(host);
    shadowRoot.append(image, map);

    expect(findMapForImage(image)).toBe(map);
    expect(findImageForArea(area)).toBe(image);
  });
});

describe('resolveImageMapTargetAtPoint', () => {
  it.each([
    ['rect', 'rect'],
    ['rectangle', 'rectangle'],
    ['missing shape', null],
    ['invalid shape', 'triangle'],
  ])('normalizes %s to a rectangle and swaps reversed edges', (_label, shape) => {
    const { image, area } = createFixture({
      shape,
      coords: '80,\t60 20,\n10',
    });

    expect(resolveImageMapTargetAtPoint(image, 130, 70)).toEqual({
      area,
      image,
      bounds: { x: 120, y: 60, width: 60, height: 50 },
    });
  });

  it.each(['circle', 'circ'])('supports the %s circle keyword and ignores excess coords', (shape) => {
    const { image, area } = createFixture({ shape, coords: '50 50,20,999' });

    expect(resolveImageMapTargetAtPoint(image, 150, 100)).toEqual({
      area,
      image,
      bounds: { x: 130, y: 80, width: 40, height: 40 },
    });
    expect(resolveImageMapTargetAtPoint(image, 180, 100)).toBeNull();
  });

  it.each(['poly', 'polygon'])('supports the %s polygon keyword, odd tails, and edges', (shape) => {
    const { image, area } = createFixture({
      shape,
      coords: '10,10 60,10 60,40 10,40,999',
    });

    expect(resolveImageMapTargetAtPoint(image, 110, 75)).toEqual({
      area,
      image,
      bounds: { x: 110, y: 60, width: 50, height: 30 },
    });
  });

  it('uses the even-odd rule for a self-overlapping polygon', () => {
    const { image, map } = createFixture({
      shape: 'poly',
      coords: '10,10,100,10,100,90,10,90,10,10,100,10,100,90,10,90',
    });
    const fallback = appendDefaultArea(map);

    expect(resolveImageMapTargetAtPoint(image, 150, 80)).toEqual({
      area: fallback,
      image,
      bounds: { x: 100, y: 50, width: 200, height: 100 },
    });
  });

  it('treats too-short coordinate lists as empty and ignores coords for default', () => {
    for (const [shape, coords] of [
      ['rect', '0,0,20'],
      ['circle', '50,50'],
      ['poly', '0,0,20,0,20'],
    ] as const) {
      document.body.replaceChildren();
      const { image, map } = createFixture({ shape, coords });
      const fallback = appendDefaultArea(map);
      fallback.coords = 'not,used,at,all';

      expect(resolveImageMapTargetAtPoint(image, 110, 60)?.area).toBe(fallback);
    }
  });

  it('uses displayed CSS pixels even when natural dimensions and object-fit differ', () => {
    const { image, area } = createFixture({
      shape: 'rect',
      coords: '0,0,200,200',
      width: 200,
      height: 200,
    });
    image.style.objectFit = 'contain';
    image.style.objectPosition = 'center';
    defineMetric(image, 'naturalWidth', 1_000);
    defineMetric(image, 'naturalHeight', 500);

    expect(resolveImageMapTargetAtPoint(image, 105, 55)).toEqual({
      area,
      image,
      bounds: { x: 100, y: 50, width: 200, height: 200 },
    });
  });

  it('uses only the required rect coordinates and ignores malformed regions', () => {
    const { image, map, area } = createFixture({ shape: 'rect', coords: '0,0,20,20,100,100' });
    const malformed = document.createElement('area');
    malformed.href = '#malformed';
    malformed.shape = 'circle';
    malformed.coords = '50,50,0';
    const fallback = appendDefaultArea(map);
    map.insertBefore(malformed, fallback);

    expect(resolveImageMapTargetAtPoint(image, 110, 60)?.area).toBe(area);
    expect(resolveImageMapTargetAtPoint(image, 150, 90)).toEqual({
      area: fallback,
      image,
      bounds: { x: 100, y: 50, width: 200, height: 100 },
    });
  });

  it('rejects areas whose associated image is visually unavailable', () => {
    const { image } = createFixture();
    image.style.opacity = '0';

    expect(resolveImageMapTargetAtPoint(image, 120, 70)).toBeNull();
  });

  it('preserves fractional border-box coordinates at the image edge', () => {
    const { image, area } = createFixture({
      coords: '100.25,0,100.5,50.5',
      x: 0,
      y: 0,
      width: 100.5,
      height: 50.5,
    });
    image.style.width = '100.5px';
    image.style.height = '50.5px';
    image.style.boxSizing = 'border-box';
    defineMetric(image, 'offsetWidth', 101);
    defineMetric(image, 'offsetHeight', 51);

    expect(resolveImageMapTargetAtPoint(image, 100.3, 25)).toEqual({
      area,
      image,
      bounds: { x: 100.25, y: 0, width: 0.25, height: 50.5 },
    });
  });

  it('does not expose a lower link through a non-actionable top area', () => {
    const { image, map, area } = createFixture({ shape: 'rect', coords: '0,0,100,100' });
    area.removeAttribute('href');
    const fallback = appendDefaultArea(map);

    expect(resolveImageMapTargetAtPoint(image, 110, 60)).toBeNull();
    expect(resolveImageMapTargetAtPoint(image, 250, 100)?.area).toBe(fallback);
  });
});
