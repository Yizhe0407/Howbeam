import { describe, expect, it } from 'vitest';
import { buildLibraryItems, libraryItemMatches, seriesByProject, type LibraryItem, type SeriesWithProjects } from '@/lib/project/library-items';
import type { ProjectSummary } from '@/lib/storage/models';
import type { ProjectSeries } from '@/lib/storage/series-model';

const project = (id: string, updatedAt: number, title = id): ProjectSummary => ({
  id,
  title,
  description: '',
  sections: [],
  createdAt: 0,
  updatedAt,
  contentRevision: 0,
  stepEditRevision: 0,
  metadataRevision: 0,
  stepCount: 0,
  entryCount: 0,
  storageBytes: 0,
});
const series = (id: string, projectIds: string[], updatedAt = 0, title = id): ProjectSeries => ({
  id,
  title,
  projectIds,
  createdAt: 0,
  updatedAt,
});
const lower = (text: string) => text.toLowerCase();

function onlySeries(items: LibraryItem[]): SeriesWithProjects {
  const [item] = items;
  if (item?.kind !== 'series') throw new Error('expected one Series');
  return item;
}

describe('buildLibraryItems', () => {
  it('shows a member only through its Series, newest first', () => {
    const items = buildLibraryItems(
      [project('a', 10), project('b', 30), project('c', 20)],
      [series('s', ['a', 'b'], 5)],
    );
    expect(items.map((item) => (item.kind === 'series' ? `series:${item.series.id}` : item.project.id)))
      .toEqual(['series:s', 'c']);
  });

  it('dates a Series by its latest edit or its latest member', () => {
    expect(onlySeries(buildLibraryItems([project('a', 10)], [series('s', ['a'], 50)])).updatedAt).toBe(50);
  });

  it('keeps the Series order and skips members that no longer exist', () => {
    const item = onlySeries(buildLibraryItems([project('a', 1), project('b', 2)], [series('s', ['b', 'gone', 'a'])]));
    expect(item.projects.map((member) => member.id)).toEqual(['b', 'a']);
  });
});

describe('libraryItemMatches', () => {
  const item: LibraryItem = { kind: 'series', ...onlySeries(buildLibraryItems([project('a', 1, 'Payroll')], [series('s', ['a'], 0, 'HR guides')])) };

  it('matches a Series by its title or a member', () => {
    expect(libraryItemMatches(item, 'hr', lower)).toBe(true);
    expect(libraryItemMatches(item, 'payroll', lower)).toBe(true);
    expect(libraryItemMatches(item, 'leave', lower)).toBe(false);
  });
});

describe('seriesByProject', () => {
  it('maps each member to its Series', () => {
    const entry = series('s', ['a', 'b']);
    expect([...seriesByProject([entry]).keys()]).toEqual(['a', 'b']);
  });
});
