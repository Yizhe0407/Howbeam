import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  compositeHighlight: vi.fn(),
  compositeMultiHighlight: vi.fn(),
  getCroppedImage: vi.fn(),
}));

vi.mock('@/lib/media/crop-image', () => ({ getCroppedImage: mocks.getCroppedImage }));

vi.mock('@/lib/media/annotation-composite', () => ({
  compositeHighlight: mocks.compositeHighlight,
  compositeMultiHighlight: mocks.compositeMultiHighlight,
}));

import { compositeStepEntry } from '@/lib/export/entry-render';
import { type Step, type StepEntry } from '@/lib/storage/models';
import { itemAt } from '../setup/item-at';

function makeStep(id: string, order: number, changes: Partial<Step> = {}): Step {
  return {
    id,
    sessionId: 'session',
    order,
    screenshotBlob: new Blob([id], { type: 'image/jpeg' }),
    bounds: { x: 10, y: 20, width: 30, height: 40 },
    devicePixelRatio: 1,
    description: '',
    url: 'https://example.com',
    timestamp: order,
    ...changes,
  };
}

beforeEach(() => {
  mocks.compositeHighlight.mockReset().mockResolvedValue(new Blob(['single'], { type: 'image/png' }));
  mocks.compositeMultiHighlight.mockReset().mockResolvedValue(new Blob(['group'], { type: 'image/jpeg' }));
  mocks.getCroppedImage.mockReset().mockResolvedValue(null);
});

describe('compositeStepEntry', () => {
  it('uses a single entry’s effective manual bounds and owned redactions', async () => {
    const step = makeStep('single', 1, {
      manualBounds: { x: 50, y: 60, width: 70, height: 80 },
      screenshotScale: 2,
      redactions: [{ id: 'mask', kind: 'solid', bounds: { x: 1, y: 2, width: 3, height: 4 } }],
    });
    const entry: StepEntry = { kind: 'single', step: step as Step & { screenshotBlob: Blob } };

    await compositeStepEntry(entry, 'image/png');

    expect(mocks.compositeHighlight).toHaveBeenCalledWith(
      step.screenshotBlob,
      step.manualBounds,
      2,
      'image/png',
      step.redactions,
      false,
      [],
    );
    expect(mocks.compositeMultiHighlight).not.toHaveBeenCalled();
  });

  it('uses the group anchor screenshot and masks while retaining all effective annotations', async () => {
    const anchor = makeStep('anchor', 1, {
      groupId: 'anchor',
      bounds: null,
      screenshotScale: 1.5,
      numbered: true,
      redactions: [{ id: 'mask', kind: 'solid', bounds: { x: 80, y: 90, width: 10, height: 20 } }],
    });
    const automatic = makeStep('automatic', 2, { groupId: 'anchor', screenshotBlob: undefined });
    const manual = makeStep('manual', 3, {
      groupId: 'anchor',
      screenshotBlob: undefined,
      manualBounds: { x: 100, y: 110, width: 12, height: 13 },
    });
    const entry: StepEntry = {
      kind: 'group',
      anchor: anchor as Step & { screenshotBlob: Blob },
      annotations: [automatic, manual],
    };

    await compositeStepEntry(entry, 'image/jpeg');

    expect(mocks.compositeMultiHighlight).toHaveBeenCalledWith(
      anchor.screenshotBlob,
      [
        { bounds: automatic.bounds, order: 1 },
        { bounds: manual.manualBounds, order: 2 },
      ],
      1.5,
      true,
      'image/jpeg',
      anchor.redactions,
      false,
      [],
    );
    expect(mocks.compositeHighlight).not.toHaveBeenCalled();
  });

  it('propagates privacy review as a full-image fail-closed render request', async () => {
    const step = makeStep('review', 1, {
      redactions: [{ id: 'mask', kind: 'solid', bounds: { x: 1, y: 2, width: 3, height: 4 } }],
      redactionReviewRequired: true,
    });
    const entry: StepEntry = { kind: 'single', step: step as Step & { screenshotBlob: Blob } };

    await compositeStepEntry(entry, 'image/png');

    expect(mocks.compositeHighlight).toHaveBeenCalledWith(
      step.screenshotBlob,
      step.bounds,
      1,
      'image/png',
      step.redactions,
      true,
      [],
    );
  });

  it('hands the owner\u2019s drawn edits to the compositor so exports match the editor', async () => {
    const edits = [{ id: 'e1', kind: 'rect' as const, bounds: { x: 1, y: 2, width: 3, height: 4 }, width: 2, fill: 'none' as const, color: '#ff4747' }];
    const step = makeStep('drawn', 1, { imageEdits: edits });
    const entry: StepEntry = { kind: 'single', step: step as Step & { screenshotBlob: Blob } };

    await compositeStepEntry(entry, 'image/png');

    expect(mocks.compositeHighlight).toHaveBeenCalledWith(step.screenshotBlob, step.bounds, 1, 'image/png', [], false, edits);
  });

  describe('with a crop', () => {
    const crop = { x: 100, y: 50, width: 400, height: 300 };
    const croppedBlob = new Blob(['cropped'], { type: 'image/png' });

    beforeEach(() => mocks.getCroppedImage.mockResolvedValue({ blob: croppedBlob, origin: { x: 100, y: 50 } }));

    it('renders the cut-out region with every coordinate shifted by its origin', async () => {
      const step = makeStep('cropped', 1, {
        crop,
        bounds: { x: 150, y: 90, width: 30, height: 40 },
        redactions: [{ id: 'm', kind: 'solid', bounds: { x: 120, y: 70, width: 10, height: 10 } }],
        imageEdits: [{ id: 'e', kind: 'rect', bounds: { x: 200, y: 100, width: 20, height: 20 }, width: 2, fill: 'none' as const, color: '#ff4747' }],
      });
      const entry: StepEntry = { kind: 'single', step: step as Step & { screenshotBlob: Blob } };

      await compositeStepEntry(entry, 'image/png');

      expect(mocks.getCroppedImage).toHaveBeenCalledWith(step.screenshotBlob, crop, 1);
      expect(mocks.compositeHighlight).toHaveBeenCalledWith(
        croppedBlob,
        { x: 50, y: 40, width: 30, height: 40 },
        1,
        'image/png',
        [{ id: 'm', kind: 'solid', bounds: { x: 20, y: 20, width: 10, height: 10 } }],
        false,
        [{ id: 'e', kind: 'rect', bounds: { x: 100, y: 50, width: 20, height: 20 }, width: 2, fill: 'none' as const, color: '#ff4747' }],
      );
    });

    it('shifts snapshot annotations the same way', async () => {
      const anchor = makeStep('anchor', 1, { groupId: 'anchor', bounds: null, crop });
      const note = makeStep('note', 2, { groupId: 'anchor', screenshotBlob: undefined, bounds: { x: 110, y: 60, width: 5, height: 5 } });
      const entry: StepEntry = { kind: 'group', anchor: anchor as Step & { screenshotBlob: Blob }, annotations: [note] };

      await compositeStepEntry(entry, 'image/jpeg');

      expect(itemAt(mocks.compositeMultiHighlight.mock.calls, 0)[0]).toBe(croppedBlob);
      expect(itemAt(mocks.compositeMultiHighlight.mock.calls, 0)[1]).toEqual([{ bounds: { x: 10, y: 10, width: 5, height: 5 }, order: 1 }]);
    });

    it('uses the original image untouched when the crop turns out to cover all of it', async () => {
      mocks.getCroppedImage.mockResolvedValue(null);
      const step = makeStep('whole', 1, { crop });
      const entry: StepEntry = { kind: 'single', step: step as Step & { screenshotBlob: Blob } };

      await compositeStepEntry(entry, 'image/png');

      expect(itemAt(mocks.compositeHighlight.mock.calls, 0)[0]).toBe(step.screenshotBlob);
      expect(itemAt(mocks.compositeHighlight.mock.calls, 0)[1]).toEqual(step.bounds);
    });
  });
});
