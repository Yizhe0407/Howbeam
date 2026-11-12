import { describe, expect, it } from 'vitest';
import { isValidImageEdit, readImageEdits } from '@/lib/storage/image-edit-model';
import { getEntryImageEdits, sanitizeStepForStorage, type Step, type StepEntry } from '@/lib/storage/models';

const rect = {
  id: 'r1',
  kind: 'rect' as const,
  bounds: { x: 1, y: 2, width: 30, height: 40 },
  width: 2,
  fill: 'none' as const,
  color: '#ff4747',
};
const text = {
  id: 't1',
  kind: 'text' as const,
  bounds: { x: 1, y: 2, width: 100, height: 31 },
  text: 'Hello',
  fontSize: 24,
  look: 'plain' as const,
  color: '#111111',
};
const arrow = {
  id: 'a1',
  kind: 'arrow' as const,
  from: { x: 0, y: 0 },
  to: { x: 50, y: 60 },
  width: 4,
  color: '#2f6fed',
};

function step(overrides: Partial<Step> = {}): Step {
  return {
    id: 's1',
    sessionId: 'p',
    order: 0,
    bounds: null,
    devicePixelRatio: 1,
    description: '',
    url: 'https://x.test',
    timestamp: 0,
    ...overrides,
  };
}

describe('image edit validation', () => {
  it('accepts well-formed edits of every kind', () => {
    expect([rect, text, arrow].every(isValidImageEdit)).toBe(true);
  });

  it.each([
    ['unknown colour', { ...rect, color: 'pink' }],
    ['non-palette colour string', { ...rect, color: '#fff' }],
    ['zero-size box', { ...rect, bounds: { x: 0, y: 0, width: 0, height: 5 } }],
    ['NaN coordinate', { ...arrow, to: { x: Number.NaN, y: 1 } }],
    ['empty text', { ...text, text: '' }],
    ['oversized text', { ...text, text: 'x'.repeat(5_000) }],
    ['C1 control character in text', { ...text, text: 'a\u0085b' }],
    ['tiny font', { ...text, fontSize: 2 }],
    ['wild stroke', { ...rect, width: 500 }],
    ['control characters in id', { ...rect, id: 'a\u0000b' }],
    ['unknown kind', { ...rect, kind: 'circle' }],
    ['not an object', 'rect'],
  ])('rejects %s', (_name, value) => {
    expect(isValidImageEdit(value)).toBe(false);
  });

  it('keeps only usable, unique edits and copies them', () => {
    const result = readImageEdits([rect, { ...rect, color: 'pink' }, rect, text]);
    expect(result.map((edit) => edit.id)).toEqual(['r1', 't1']);
    expect(result[0]).not.toBe(rect);
    expect(readImageEdits('nope')).toEqual([]);
  });
});

describe('image edits on steps', () => {
  it('are stored on image owners only and stripped of unknown fields', () => {
    const stored = sanitizeStepForStorage(
      step({ imageEdits: [{ ...rect, extra: 1 } as never, { ...rect, id: 'bad', color: 'pink' } as never] }),
    );
    expect(stored.imageEdits).toEqual([rect]);

    const annotation = sanitizeStepForStorage(step({ id: 'g-note', groupId: 'g', imageEdits: [rect] }));
    expect(annotation.imageEdits).toBeUndefined();
  });

  it('refuses a step with too many edits', () => {
    const many = Array.from({ length: 501 }, (_, index) => ({ ...rect, id: `r${index}` }));
    expect(() => sanitizeStepForStorage(step({ imageEdits: many }))).toThrow(/too many image edits/);
  });

  it('reads an entry’s edits with stable identity', () => {
    const owner = { ...step({ imageEdits: [rect] }), screenshotBlob: new Blob(['x']) };
    const entry: StepEntry = { kind: 'single', step: owner };
    expect(getEntryImageEdits(entry)).toEqual([rect]);
    expect(getEntryImageEdits(entry)).toBe(getEntryImageEdits(entry));
    expect(getEntryImageEdits({ kind: 'single', step: { ...owner, imageEdits: undefined } })).toEqual([]);
  });

  it('keep a crop on image owners only, and drop an invalid one', () => {
    const crop = { x: 10, y: 20, width: 100, height: 50 };
    expect(sanitizeStepForStorage(step({ crop })).crop).toEqual(crop);
    expect(sanitizeStepForStorage(step({ crop: { x: 0, y: 0, width: 0, height: 5 } })).crop).toBeUndefined();
    expect(sanitizeStepForStorage(step({ crop: null })).crop).toBeUndefined();
    expect(sanitizeStepForStorage(step({ id: 'g-note', groupId: 'g', crop })).crop).toBeUndefined();
  });
});
