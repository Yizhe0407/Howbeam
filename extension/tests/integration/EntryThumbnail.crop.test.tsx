// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenshotStep, StepEntry } from '@/lib/storage/models';

const mocks = vi.hoisted(() => ({
  highlight: vi.fn(),
  getCroppedImage: vi.fn(),
  peekCroppedImage: vi.fn(),
}));

vi.mock('@/components/editor/HighlightThumbnail', () => ({
  default: (props: unknown) => {
    mocks.highlight(props);
    return <div data-testid="thumb" />;
  },
}));
vi.mock('@/components/editor/MultiHighlightThumbnail', () => ({ default: () => null }));
vi.mock('@/lib/media/crop-image', () => ({
  getCroppedImage: mocks.getCroppedImage,
  peekCroppedImage: mocks.peekCroppedImage,
}));

import EntryThumbnail from '@/components/editor/EntryThumbnail';
import { itemAt } from '../setup/item-at';

const original = new Blob(['original-pixels'], { type: 'image/png' });
const cropped = new Blob(['cropped-pixels'], { type: 'image/png' });
const crop = { x: 100, y: 50, width: 400, height: 300 };

function entry(overrides: Partial<ScreenshotStep> = {}): StepEntry {
  return {
    kind: 'single',
    step: {
      id: 's', sessionId: 'p', order: 0, bounds: { x: 150, y: 90, width: 30, height: 40 }, devicePixelRatio: 1,
      description: '', url: 'https://x.test', timestamp: 0, screenshotBlob: original,
      redactions: [{ id: 'm', kind: 'solid', bounds: { x: 120, y: 70, width: 10, height: 10 } }],
      ...overrides,
    },
  };
}

beforeEach(() => {
  mocks.highlight.mockClear();
  mocks.getCroppedImage.mockReset();
  mocks.peekCroppedImage.mockReset().mockReturnValue(undefined);
});
afterEach(cleanup);

describe('EntryThumbnail with a crop', () => {
  it('shows nothing, never the uncropped image, until the first cut is ready, then the cut with shifted coordinates', async () => {
    let finish: (value: unknown) => void = () => undefined;
    mocks.getCroppedImage.mockReturnValue(new Promise((resolve) => { finish = resolve; }));

    const view = render(<EntryThumbnail entry={entry({ crop })} alt="x" />);
    expect(view.queryByTestId('thumb')).toBeNull();
    expect(mocks.highlight).not.toHaveBeenCalled();

    await act(async () => finish({ blob: cropped, origin: { x: 100, y: 50 } }));

    expect(view.getByTestId('thumb')).toBeTruthy();
    const props = mocks.highlight.mock.calls.at(-1)![0];
    expect(props.blob).toBe(cropped);
    expect(props.bounds).toEqual({ x: 50, y: 40, width: 30, height: 40 });
    expect(props.redactions[0].bounds).toEqual({ x: 20, y: 20, width: 10, height: 10 });
  });

  it('uses an already-computed cut straight away, with no blank frame', () => {
    mocks.peekCroppedImage.mockReturnValue({ value: { blob: cropped, origin: { x: 100, y: 50 } } });
    const view = render(<EntryThumbnail entry={entry({ crop })} alt="x" />);
    expect(view.getByTestId('thumb')).toBeTruthy();
    expect(itemAt(mocks.highlight.mock.calls, 0)[0].blob).toBe(cropped);
  });

  it('shows the whole image with unshifted coordinates when there is no crop, or the editor asks for none', () => {
    const plain = render(<EntryThumbnail entry={entry()} alt="x" />);
    expect(mocks.highlight.mock.calls.at(-1)![0].blob).toBe(original);
    expect(mocks.highlight.mock.calls.at(-1)![0].bounds).toEqual({ x: 150, y: 90, width: 30, height: 40 });
    plain.unmount();

    render(<EntryThumbnail entry={entry({ crop })} crop={null} alt="x" />);
    expect(mocks.highlight.mock.calls.at(-1)![0].blob).toBe(original);
    expect(mocks.getCroppedImage).not.toHaveBeenCalled();
  });

  it('falls back to the whole image when the crop covers all of it', async () => {
    mocks.getCroppedImage.mockResolvedValue(null);
    const view = render(<EntryThumbnail entry={entry({ crop })} alt="x" />);
    await act(async () => undefined);
    expect(view.getByTestId('thumb')).toBeTruthy();
    expect(mocks.highlight.mock.calls.at(-1)![0].blob).toBe(original);
  });
});
