import { projectDisplayTitle, type ProjectSummary } from '../storage/models';
import { seriesDisplayTitle, type ProjectSeries } from '../storage/series-model';

export interface SeriesWithProjects {
  series: ProjectSeries;
  /** Members that still exist, in the Series' order. */
  projects: ProjectSummary[];
  /** The latest edit to the Series or any of its Projects. */
  updatedAt: number;
}

export type LibraryItem =
  | { kind: 'project'; project: ProjectSummary }
  | ({ kind: 'series' } & SeriesWithProjects);

export function resolveSeries(series: ProjectSeries, projectsById: ReadonlyMap<string, ProjectSummary>): SeriesWithProjects {
  const projects = series.projectIds.flatMap((id) => projectsById.get(id) ?? []);
  const updatedAt = Math.max(series.updatedAt, ...projects.map((project) => project.updatedAt));
  return { series, projects, updatedAt };
}

/**
 * What the Library lists: each Series once, and every Project that is in no
 * Series, newest first. A Project in a Series is shown only through it.
 */
export function buildLibraryItems(projects: readonly ProjectSummary[], series: readonly ProjectSeries[]): LibraryItem[] {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const grouped = series.map((entry) => resolveSeries(entry, projectsById));
  const inSeries = new Set(grouped.flatMap(({ projects: members }) => members.map((project) => project.id)));
  const items: LibraryItem[] = [
    ...grouped.map((entry) => ({ kind: 'series' as const, ...entry })),
    ...projects
      .filter((project) => !inSeries.has(project.id))
      .map((project) => ({ kind: 'project' as const, project })),
  ];
  return items.sort((first, second) => itemUpdatedAt(second) - itemUpdatedAt(first));
}

function itemUpdatedAt(item: LibraryItem): number {
  return item.kind === 'project' ? item.project.updatedAt : item.updatedAt;
}

function projectText(project: ProjectSummary): string {
  return `${projectDisplayTitle(project.title)}\n${project.description}`;
}

/** A Series matches when its title or any of its Projects does. `query` must already be normalized. */
export function libraryItemMatches(item: LibraryItem, query: string, normalize: (text: string) => string): boolean {
  if (!query) return true;
  if (item.kind === 'project') return normalize(projectText(item.project)).includes(query);
  return [seriesDisplayTitle(item.series.title), ...item.projects.map(projectText)]
    .some((text) => normalize(text).includes(query));
}

/** Which Series each Project is in, by Project id. */
export function seriesByProject(series: readonly ProjectSeries[]): Map<string, ProjectSeries> {
  return new Map(series.flatMap((entry) => entry.projectIds.map((id) => [id, entry] as const)));
}
