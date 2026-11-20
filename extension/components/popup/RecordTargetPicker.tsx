import { useEffect, useState } from 'react';
import { FolderOpen, Layers, Plus } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getProjectSummaries } from '@/lib/storage/project-repository';
import { subscribeProjectsChanged, subscribeSeriesChanged } from '@/lib/storage/change-notifier';
import { getAllSeries } from '@/lib/storage/series-repository';
import { seriesDisplayTitle, type ProjectSeries } from '@/lib/storage/series-model';
import { seriesByProject } from '@/lib/project/library-items';
import { NEW_PROJECT_TARGET, type RecordTarget } from '@/lib/project/record-target';
import { projectDisplayTitle, type ProjectSummary } from '@/lib/storage/models';
import { t } from '@/lib/shared/i18n';
import { cn } from '@/lib/shared/utils';
import OverflowTooltip from '@/components/shared/OverflowTooltip';

/** How many of the most recently updated Projects (and Series) the popup offers. Browsing the
 * rest is the Library's job; the popup only needs the one just worked on. */
const RECORD_TARGET_RECENT_LIMIT = 5;

// Radix Select cannot hold an empty value, and a bare sentinel could collide
// with an id, so every Project and Series option carries its own prefix.
const NEW_VALUE = 'new';
const SERIES_PREFIX = 'series:';
const PROJECT_PREFIX = 'project:';

function encode(target: RecordTarget): string {
  if (target.kind === 'project') return `${PROJECT_PREFIX}${target.projectId}`;
  return target.seriesId ? `${SERIES_PREFIX}${target.seriesId}` : NEW_VALUE;
}

function decode(value: string): RecordTarget {
  if (value.startsWith(PROJECT_PREFIX)) return { kind: 'project', projectId: value.slice(PROJECT_PREFIX.length) };
  if (value.startsWith(SERIES_PREFIX)) return { kind: 'new', seriesId: value.slice(SERIES_PREFIX.length) };
  return NEW_PROJECT_TARGET;
}

/** The newest `limit`, plus `selected` when it is older, so the trigger never renders blank. */
function recentWith<T>(all: readonly T[], selected: T | undefined): T[] {
  const recent = all.slice(0, RECORD_TARGET_RECENT_LIMIT);
  return selected && !recent.includes(selected) ? [...recent, selected] : recent;
}

/** A Series' name under an option's main line. */
function SeriesLabel({ title }: { title: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <Layers className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{title}</span>
    </span>
  );
}

interface Props {
  value: RecordTarget;
  onChange: (target: RecordTarget) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * 「錄到哪裡」: the popup's opt-in for appending to an existing Project, or for
 * starting a new Project inside a Series. The default stays 新專案 so a stray
 * click can never mix steps into finished work. Renders nothing until the
 * Library holds a Project or a Series, so a first-time user sees no extra control.
 */
export default function RecordTargetPicker({ value, onChange, disabled = false, className }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [series, setSeries] = useState<ProjectSeries[]>([]);
  /** Series title by Project id, for the Projects that are in one. */
  const [seriesTitles, setSeriesTitles] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    let active = true;
    const load = () => {
      void getProjectSummaries()
        .then((all) => {
          if (!active) return;
          // A Project deleted while the popup is open must not stay selected:
          // starting would fail with 找不到這個專案 and the picker would still show it.
          const selected = value.kind === 'project' ? all.find((project) => project.id === value.projectId) : undefined;
          if (value.kind === 'project' && !selected) onChange(NEW_PROJECT_TARGET);
          setProjects(recentWith(all, selected));
        })
        .catch((error) => {
          // Fail closed to "new project only": a missing list must never block recording.
          console.warn('[howbeam] failed to read projects for the record target', error);
        });
    };
    // Series only add choices and labels: a failed read leaves them off, never the Project list.
    const loadSeries = () => {
      void getAllSeries()
        .then((all) => {
          if (!active) return;
          const newest = [...all].sort((first, second) => second.updatedAt - first.updatedAt);
          const selected = value.kind === 'new' && value.seriesId ? newest.find((entry) => entry.id === value.seriesId) : undefined;
          // Same rule as a deleted Project: a Series gone while the popup is open falls back to 新專案.
          if (value.kind === 'new' && value.seriesId && !selected) onChange(NEW_PROJECT_TARGET);
          setSeries(recentWith(newest, selected));
          const titles = new Map<string, string>();
          for (const [projectId, entry] of seriesByProject(all)) titles.set(projectId, seriesDisplayTitle(entry.title));
          setSeriesTitles(titles);
        })
        .catch((error) => {
          console.warn('[howbeam] failed to read series for the record target', error);
        });
    };
    load();
    loadSeries();
    const unsubscribe = subscribeProjectsChanged(load);
    const unsubscribeSeries = subscribeSeriesChanged(loadSeries);
    return () => {
      active = false;
      unsubscribe();
      unsubscribeSeries();
    };
    // `onChange` is a setState in the caller; the lists re-read when the selection changes.
  }, [value, onChange]);

  if (projects.length === 0 && series.length === 0) return null;
  const selectedProject = value.kind === 'project' ? projects.find((project) => project.id === value.projectId) : undefined;
  const selectedSeries = value.kind === 'new' && value.seriesId ? series.find((entry) => entry.id === value.seriesId) : undefined;

  return (
    <Select value={encode(value)} onValueChange={(next) => onChange(decode(next))} disabled={disabled}>
      <SelectTrigger
        aria-label={t().popup.recordTarget}
        className={cn(
          'h-9 w-full gap-2 border-2 border-border bg-card px-3 text-sm font-bold text-foreground focus-ring focus-visible:border-border focus-visible:ring-0 data-[size=default]:h-9 dark:bg-card dark:hover:bg-secondary *:data-[slot=select-value]:flex-1',
          className,
        )}
      >
        {selectedProject ? <FolderOpen aria-hidden="true" /> : <Plus aria-hidden="true" />}
        {/* Its own one-line content: the options wrap long titles, which a one-line trigger cannot. */}
        <SelectValue>
          {selectedProject ? (
            <>
              {/* The trigger is one line; the tooltip keeps a long title reachable. */}
              <OverflowTooltip content={projectDisplayTitle(selectedProject.title)}>
                <span className="min-w-0 flex-1 truncate">{projectDisplayTitle(selectedProject.title)}</span>
              </OverflowTooltip>
              <span className="shrink-0 text-xs font-bold text-muted-foreground">{t().popup.recordTargetCount(selectedProject.entryCount)}</span>
            </>
          ) : selectedSeries ? (
            <OverflowTooltip content={t().popup.recordTargetNewInSeries(seriesDisplayTitle(selectedSeries.title))}>
              <span className="min-w-0 flex-1 truncate">{t().popup.recordTargetNewInSeries(seriesDisplayTitle(selectedSeries.title))}</span>
            </OverflowTooltip>
          ) : t().popup.recordTargetNew}
        </SelectValue>
      </SelectTrigger>
      {/* The popup is a fixed 320px window that clips anything drawn past its
          edge, so the list is pinned to the trigger's width instead of growing
          with its longest title; a long title wraps to two lines and the count stays visible. */}
      <SelectContent
        position="popper"
        className="w-(--radix-select-trigger-width) max-w-(--radix-select-trigger-width) min-w-0 border-0 ring-2 ring-border"
      >
        <SelectItem value={NEW_VALUE} className="font-bold">{t().popup.recordTargetNew}</SelectItem>
        {series.map((entry) => (
          <SelectItem key={entry.id} value={`${SERIES_PREFIX}${entry.id}`} className="font-bold">
            <span className="flex min-w-0 flex-1 flex-col">
              <span>{t().popup.recordTargetNew}</span>
              <SeriesLabel title={seriesDisplayTitle(entry.title)} />
            </span>
          </SelectItem>
        ))}
        {projects.map((project) => (
          <SelectItem key={project.id} value={`${PROJECT_PREFIX}${project.id}`} className="font-bold">
            <span className="flex min-w-0 flex-1 flex-col">
              <OverflowTooltip content={projectDisplayTitle(project.title)}>
                <span className="line-clamp-2 min-w-0 break-words">
                  {projectDisplayTitle(project.title)}
                </span>
              </OverflowTooltip>
              {seriesTitles.has(project.id) && <SeriesLabel title={seriesTitles.get(project.id)!} />}
            </span>
            <span className="shrink-0 text-xs font-bold text-muted-foreground">
              {t().popup.recordTargetCount(project.entryCount)}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
