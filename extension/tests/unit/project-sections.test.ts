import { describe, expect, it } from 'vitest';

import { type Step, type StepEntry } from '@/lib/storage/models';
import {
  PROJECT_SECTION_LIMITS,
  repairProjectSections,
  sanitizeProjectSectionTitle,
  sectionOfEntry,
} from '@/lib/project/project-sections';

function step(id: string, order: number, overrides: Partial<Step> = {}): Step {
  return {
    id,
    sessionId: 'project-1',
    order,
    screenshotBlob: new Blob([id], { type: 'image/png' }),
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    devicePixelRatio: 1,
    description: id,
    url: 'https://example.com/',
    timestamp: order,
    ...overrides,
  };
}

function entries(): StepEntry[] {
  const anchor = step('snapshot', 1, { bounds: null, groupId: 'snapshot' });
  const annotation = step('annotation', 2, {
    screenshotBlob: undefined,
    groupId: 'snapshot',
  });
  return [
    { kind: 'single', step: step('first', 0) as Step & { screenshotBlob: Blob } },
    {
      kind: 'group',
      anchor: anchor as Step & { screenshotBlob: Blob },
      annotations: [annotation],
    },
    { kind: 'single', step: step('last', 3) as Step & { screenshotBlob: Blob } },
  ];
}

describe('project sections', () => {
  it('sanitizes titles as bounded single-line display text', () => {
    expect(sanitizeProjectSectionTitle('\u0000  First\n\tchapter\u007f  ')).toBe('Firstchapter');
    expect(sanitizeProjectSectionTitle('x'.repeat(PROJECT_SECTION_LIMITS.maxTitleLength + 20))).toHaveLength(
      PROJECT_SECTION_LIMITS.maxTitleLength,
    );
    expect(sanitizeProjectSectionTitle(null)).toBe('');
  });

  it('keeps only complete entry boundaries and sorts by timeline order', () => {
    expect(repairProjectSections([
      { id: 'last-section', title: ' Last ', startEntryId: 'last' },
      { id: 'annotation-section', title: 'Unsafe middle', startEntryId: 'annotation' },
      { id: 'first-section', title: 'First', startEntryId: 'first' },
      { id: 'snapshot-section', title: 'Snapshot', startEntryId: 'snapshot' },
    ], entries())).toEqual([
      { id: 'first-section', title: 'First', startEntryId: 'first' },
      { id: 'snapshot-section', title: 'Snapshot', startEntryId: 'snapshot' },
      { id: 'last-section', title: 'Last', startEntryId: 'last' },
    ]);
  });

  it('drops malformed and later duplicate ids or starts deterministically', () => {
    expect(repairProjectSections([
      { id: 'same', title: 'First winner', startEntryId: 'first' },
      { id: 'same', title: 'Duplicate id', startEntryId: 'snapshot' },
      { id: 'different', title: 'Duplicate start', startEntryId: 'first' },
      { id: '', title: 'Empty id', startEntryId: 'last' },
      { id: 'empty-title', title: '\n\u0000', startEntryId: 'last' },
      { id: ' padded ', title: 'Bad id', startEntryId: 'last' },
      {
        id: 'x'.repeat(PROJECT_SECTION_LIMITS.maxIdLength + 1),
        title: 'Overlong id',
        startEntryId: 'last',
      },
      {
        id: 'overlong-start',
        title: 'Overlong start',
        startEntryId: 'x'.repeat(PROJECT_SECTION_LIMITS.maxIdLength + 1),
      },
    ], entries())).toEqual([
      { id: 'same', title: 'First winner', startEntryId: 'first' },
    ]);
  });

  it('caps repair work and output count', () => {
    const manyEntries = Array.from({ length: PROJECT_SECTION_LIMITS.maxSections + 10 }, (_, index) => ({
      kind: 'single' as const,
      step: step(`step-${index}`, index) as Step & { screenshotBlob: Blob },
    }));
    const sections = manyEntries.map((_, index) => ({
      id: `section-${index}`,
      title: `Section ${index}`,
      startEntryId: `step-${index}`,
    }));

    expect(repairProjectSections(sections, manyEntries)).toHaveLength(PROJECT_SECTION_LIMITS.maxSections);
  });

  it('finds the section an entry falls under: the last one starting at or before it', () => {
    const timeline = entries();
    const sections = [{ id: 'later', title: 'Later', startEntryId: 'snapshot' }];
    expect(sectionOfEntry(sections, timeline, 0)).toBeUndefined();
    expect(sectionOfEntry(sections, timeline, 1)?.id).toBe('later');
    expect(sectionOfEntry(sections, timeline, 2)?.id).toBe('later');
    expect(sectionOfEntry([{ id: 'first', title: 'First', startEntryId: 'first' }, ...sections], timeline, 0)?.id).toBe('first');
    expect(sectionOfEntry([], timeline, 2)).toBeUndefined();
  });
});
