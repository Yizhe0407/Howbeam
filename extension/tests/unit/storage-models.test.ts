import { describe, expect, it } from 'vitest';
import {
  ProjectStructureIntegrityError,
  buildCompleteStepEntries,
  getEntryPrivacyState,
  type Redaction,
  type ScreenshotStep,
  type Step,
  type StepEntry,
} from '@/lib/storage/models';

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: crypto.randomUUID(),
    sessionId: 'project',
    order: 0,
    screenshotBlob: new Blob(['pixels'], { type: 'image/png' }),
    bounds: { x: 1, y: 2, width: 30, height: 40 },
    devicePixelRatio: 1,
    description: '',
    url: 'https://example.com',
    timestamp: 1,
    ...overrides,
  };
}

function makeGroup(order = 0): [Step, Step, Step] {
  const groupId = crypto.randomUUID();
  return [
    makeStep({ id: groupId, groupId, order, bounds: null }),
    makeStep({ groupId, order: order + 1, screenshotBlob: undefined }),
    makeStep({ groupId, order: order + 2, screenshotBlob: undefined }),
  ];
}

describe('buildCompleteStepEntries', () => {
  it('builds a complete contiguous snapshot group', () => {
    const [anchor, first, second] = makeGroup();

    const entries = buildCompleteStepEntries([second, anchor, first], 'project');

    expect(entries).toEqual([{ kind: 'group', anchor, annotations: [first, second] }]);
  });

  it('refuses an anchor with no annotation', () => {
    const [anchor, first] = makeGroup();
    const ordinary = makeStep({ order: 3 });
    const pending = makeGroup(2)[0];

    expect(() => buildCompleteStepEntries([anchor, first, pending, ordinary], 'project')).toThrow(
      'A snapshot group has no complete annotation.',
    );
  });

  it.each(['ordinary step', 'another snapshot group'])('rejects a snapshot group split by %s', (separator) => {
    const [anchor, first, second] = makeGroup();
    const middle = separator === 'ordinary step' ? makeStep({ order: 2 }) : makeGroup(2)[0];
    second.order = 3;

    expect(() => buildCompleteStepEntries([anchor, first, middle, second], 'project')).toThrow(
      ProjectStructureIntegrityError,
    );
  });
});

describe('getEntryPrivacyState', () => {
  function singleEntry(overrides: Partial<Step> = {}): StepEntry {
    return { kind: 'single', step: makeStep(overrides) as ScreenshotStep };
  }

  function redaction(id = 'mask-1'): Redaction {
    return { id, kind: 'solid', bounds: { x: 1, y: 2, width: 10, height: 12 } };
  }

  it('returns the stored array identity when every mask is valid', () => {
    const masks = [redaction('mask-1'), redaction('mask-2')];
    const entry = singleEntry({ redactions: masks });

    const state = getEntryPrivacyState(entry);

    // Identity matters: a fresh array per call would re-render every
    // thumbnail overlay-mapping observer on each editor render.
    expect(state.redactions).toBe(masks);
    expect(state.reviewRequired).toBe(false);
  });

  it('shares one no-masks identity across entries without redactions', () => {
    const first = getEntryPrivacyState(singleEntry());
    const second = getEntryPrivacyState(singleEntry());

    expect(first.redactions).toEqual([]);
    expect(first.redactions).toBe(second.redactions);
    expect(first.reviewRequired).toBe(false);
  });

  it('requires review when the raw metadata is not an array', () => {
    const entry = singleEntry({ redactions: 'corrupt' as unknown as Redaction[] });

    const state = getEntryPrivacyState(entry);

    expect(state.redactions).toEqual([]);
    expect(state.reviewRequired).toBe(true);
  });

  it('filters malformed masks and requires review instead of hiding them', () => {
    const valid = redaction();
    const entry = singleEntry({
      redactions: [valid, { id: '', kind: 'solid' } as unknown as Redaction],
    });

    const state = getEntryPrivacyState(entry);

    expect(state.redactions).toEqual([valid]);
    expect(state.reviewRequired).toBe(true);
  });

  it('reads privacy state from the group anchor and honours its review flag', () => {
    const [anchor, first] = makeGroup();
    anchor.redactionReviewRequired = true;
    const entry: StepEntry = { kind: 'group', anchor: anchor as ScreenshotStep, annotations: [first] };

    const state = getEntryPrivacyState(entry);

    expect(state.redactions).toEqual([]);
    expect(state.reviewRequired).toBe(true);
  });
});
