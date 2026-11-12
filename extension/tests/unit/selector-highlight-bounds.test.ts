// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getHighlightBounds, getVisibleHighlightBounds } from '@/lib/capture/selector/highlight-bounds';
import {
  ACTIVATION_TARGETING_POLICY,
  findVisualTargetCandidatesAtPoint,
  selectVisualTargetCandidate,
} from '@/lib/capture/selector/visual-target';
import { makeVisible, resetSelectorDom } from '../setup/selector-dom';

afterEach(resetSelectorDom);
describe('getVisibleHighlightBounds', () => {
  it('intersects the target with its clipping ancestors and viewport', () => {
    const clip = document.createElement('div');
    const button = document.createElement('button');
    clip.style.overflowX = 'hidden';
    clip.style.overflowY = 'hidden';
    clip.append(button);
    document.body.append(clip);
    makeVisible(clip, { x: 20, y: 20, width: 100, height: 50 });
    makeVisible(button, { x: -20, y: 10, width: 200, height: 100 });

    expect(getVisibleHighlightBounds(button, 30, 30, { width: 90, height: 80 })).toEqual({
      x: 20,
      y: 20,
      width: 70,
      height: 50,
    });
  });

  it('uses the overflow scrollport inside a scaled border box', () => {
    const clip = document.createElement('div');
    const button = document.createElement('button');
    clip.style.overflowX = 'hidden';
    clip.style.overflowY = 'hidden';
    clip.append(button);
    document.body.append(clip);
    makeVisible(clip, { x: 20, y: 20, width: 200, height: 100 });
    makeVisible(button, { x: 0, y: 0, width: 300, height: 200 });
    for (const [name, value] of Object.entries({
      offsetWidth: 100,
      offsetHeight: 50,
      clientLeft: 5,
      clientTop: 4,
      clientWidth: 90,
      clientHeight: 42,
    })) {
      Object.defineProperty(clip, name, { configurable: true, value });
    }

    expect(getVisibleHighlightBounds(button, 40, 40, { width: 400, height: 300 })).toEqual({
      x: 30,
      y: 28,
      width: 180,
      height: 84,
    });
  });

  it('clips a scrolled root body against the viewport instead of its moving border box', () => {
    const button = document.createElement('button');
    document.body.append(button);
    document.body.style.overflowY = 'scroll';
    makeVisible(button, { x: 396, y: 459, width: 28, height: 28 });
    vi.spyOn(document.body, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: -420,
      top: -420,
      left: 0,
      right: 1280,
      bottom: 393,
      width: 1280,
      height: 813,
      toJSON: () => ({}),
    });

    expect(getVisibleHighlightBounds(button, 410, 473, { width: 1280, height: 813 })).toEqual({
      x: 396,
      y: 459,
      width: 28,
      height: 28,
    });

    document.body.style.overflowY = '';
  });

  it('honors paint containment shorthands', () => {
    const clip = document.createElement('div');
    const button = document.createElement('button');
    clip.style.contain = 'content';
    clip.append(button);
    document.body.append(clip);
    makeVisible(clip, { x: 20, y: 20, width: 100, height: 50 });
    makeVisible(button, { x: 0, y: 0, width: 200, height: 100 });

    expect(getVisibleHighlightBounds(button, 40, 40, { width: 400, height: 300 })).toEqual({
      x: 20,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  it('uses an image-map area region and the associated image paint ancestry', () => {
    const imageClip = document.createElement('div');
    imageClip.style.overflowX = 'hidden';
    imageClip.style.overflowY = 'hidden';
    const image = document.createElement('img');
    image.setAttribute('usemap', 'prefix#Hotspots');
    Object.defineProperty(image, 'offsetWidth', { configurable: true, value: 200 });
    Object.defineProperty(image, 'offsetHeight', { configurable: true, value: 100 });
    imageClip.append(image);

    const mapClip = document.createElement('div');
    mapClip.style.contain = 'paint';
    const map = document.createElement('map');
    map.name = 'Hotspots';
    const area = document.createElement('area');
    area.href = '#details';
    area.shape = 'rect';
    area.coords = '10,10,100,80';
    map.append(area);
    mapClip.append(map);
    document.body.append(imageClip, mapClip);

    makeVisible(image, { x: 100, y: 50, width: 200, height: 100 });
    makeVisible(imageClip, { x: 120, y: 65, width: 60, height: 35 });
    // If clipping followed <map> ancestry, this unrelated paint container
    // would erase the area instead of clipping through imageClip.
    makeVisible(mapClip, { x: 0, y: 0, width: 5, height: 5 });

    expect(Array.from(area.getClientRects())).toHaveLength(0);
    expect(getHighlightBounds(area, 130, 70)).toEqual({
      x: 110,
      y: 60,
      width: 90,
      height: 70,
    });
    expect(getVisibleHighlightBounds(area, 130, 70, { width: 400, height: 300 })).toEqual({
      x: 120,
      y: 65,
      width: 60,
      height: 35,
    });

    const selected = selectVisualTargetCandidate(
      findVisualTargetCandidatesAtPoint(area, 130, 70, { width: 400, height: 300 }, ACTIVATION_TARGETING_POLICY),
    );
    expect(selected).toMatchObject({
      element: area,
      bounds: { x: 120, y: 65, width: 60, height: 35 },
    });
  });
});
