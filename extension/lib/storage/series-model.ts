import { PERSISTED_PROJECT_LIMITS } from './persistence-limits';
import { clampStoredText, normalizeStoredLine } from './stored-text';
import { t } from '../shared/i18n';

/** An ordered group of Projects shown together in the Library. A Project belongs to at most one Series. */
export interface ProjectSeries {
  id: string;
  title: string;
  /** The order the Series lists, and later exports, its Projects in. */
  projectIds: string[];
  createdAt: number;
  updatedAt: number;
}

export const SERIES_LIMITS = Object.freeze({
  maxTitleLength: PERSISTED_PROJECT_LIMITS.maxTitleLength,
  maxProjects: 200,
});

export function sanitizeSeriesTitle(value: unknown): string {
  return typeof value === 'string'
    ? clampStoredText(normalizeStoredLine(value).trim(), SERIES_LIMITS.maxTitleLength)
    : '';
}

/** Repairs a stored row: a Project id listed twice keeps its first place. */
export function sanitizeSeries(series: ProjectSeries): ProjectSeries {
  const createdAt = Number.isFinite(series.createdAt) ? series.createdAt : Date.now();
  const ids = Array.isArray(series.projectIds) ? series.projectIds : [];
  const projectIds = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    .slice(0, SERIES_LIMITS.maxProjects);
  return {
    id: series.id,
    title: sanitizeSeriesTitle(series.title),
    projectIds,
    createdAt,
    updatedAt: Number.isFinite(series.updatedAt) ? Math.max(series.updatedAt, createdAt) : createdAt,
  };
}

/** An unnamed Series stores an empty title; this is what to show for one. */
export function seriesDisplayTitle(title: string): string {
  return title.trim() || t().library.series.untitled;
}
