// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { OVERLAY_LAYER, releaseTopLayer, showInTopLayer } from '@/lib/capture/overlay-layers';
import { firstItems } from '../setup/item-at';

/** jsdom has no popover API; this models the part that matters: the top layer is a stack ordered by showPopover() calls. */
const topLayer: HTMLElement[] = [];

function popoverHost(name: string): HTMLElement {
  const host = document.createElement('div');
  host.dataset.name = name;
  host.matches = ((selector: string) => selector === ':popover-open' ? topLayer.includes(host) : Element.prototype.matches.call(host, selector)) as typeof host.matches;
  host.showPopover = () => {
    if (topLayer.includes(host)) throw new DOMException('already open', 'InvalidStateError');
    topLayer.push(host);
  };
  host.hidePopover = () => {
    const index = topLayer.indexOf(host);
    if (index < 0) throw new DOMException('not open', 'InvalidStateError');
    topLayer.splice(index, 1);
  };
  document.documentElement.append(host);
  return host;
}

const order = () => topLayer.map((host) => host.dataset.name);

afterEach(() => {
  topLayer.length = 0;
  document.documentElement.querySelectorAll('[data-name]').forEach((element) => {
    releaseTopLayer(element as HTMLElement);
    element.remove();
  });
});

describe('top-layer stacking', () => {
  it('keeps a higher layer above a lower one that opens after it', () => {
    const toolbar = popoverHost('toolbar');
    const preview = popoverHost('preview');

    showInTopLayer(toolbar, OVERLAY_LAYER.chrome);
    showInTopLayer(preview, OVERLAY_LAYER.annotation);

    expect(order()).toEqual(['preview', 'toolbar']);
  });

  it('leaves the order alone when the lower layer opens first', () => {
    const preview = popoverHost('preview');
    const toolbar = popoverHost('toolbar');

    showInTopLayer(preview, OVERLAY_LAYER.annotation);
    showInTopLayer(toolbar, OVERLAY_LAYER.chrome);

    expect(order()).toEqual(['preview', 'toolbar']);
  });

  it('orders annotation < chrome < modal whatever the opening order', () => {
    const [annotation, chrome, modal] = firstItems(['annotation', 'chrome', 'modal'].map(popoverHost), 3);

    showInTopLayer(modal, OVERLAY_LAYER.modal);
    showInTopLayer(annotation, OVERLAY_LAYER.annotation);
    showInTopLayer(chrome, OVERLAY_LAYER.chrome);

    expect(order()).toEqual(['annotation', 'chrome', 'modal']);
  });

  it('does not reshuffle the stack when an open host is shown again', () => {
    const toolbar = popoverHost('toolbar');
    const preview = popoverHost('preview');
    showInTopLayer(toolbar, OVERLAY_LAYER.chrome);
    showInTopLayer(preview, OVERLAY_LAYER.annotation);

    showInTopLayer(preview, OVERLAY_LAYER.annotation);

    expect(order()).toEqual(['preview', 'toolbar']);
  });

  it('never raises a released or detached host', () => {
    const toolbar = popoverHost('toolbar');
    const preview = popoverHost('preview');
    showInTopLayer(toolbar, OVERLAY_LAYER.chrome);
    releaseTopLayer(toolbar);

    showInTopLayer(preview, OVERLAY_LAYER.annotation);

    expect(order()).toEqual(['toolbar', 'preview']);
  });

  it('is a no-op without popover support', () => {
    const host = document.createElement('div');
    expect(() => showInTopLayer(host, OVERLAY_LAYER.chrome)).not.toThrow();
  });
});
