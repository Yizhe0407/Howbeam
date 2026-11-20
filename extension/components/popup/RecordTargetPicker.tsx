import { useEffect, useState } from 'react';
import { FolderOpen, Layers, Plus } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getProjectSummaries } from '@/lib/storage/project-repository';
import { subscribeProjectsChanged, subscribeSeriesChanged } from '@/lib/storage/change-notifier';
import { getAllSeries } from '@/lib/storage/series-repository';
import { seriesDisplayTitle } from '@/lib/storage/series-model';
import { seriesByProject } from '@/lib/project/library-items';
import { projectDisplayTitle, type ProjectSummary } from '@/lib/storage/models';
import { t } from '@/lib/shared/i18n';
import { cn } from '@/lib/shared/utils';
import OverflowTooltip from '@/components/shared/OverflowTooltip';

/** How many of the most recently updated Projects the popup offers. Browsing the
 * rest is the Library's job; the popup only needs the one just worked on. */
const RECORD_TARGET_RECENT_LIMIT = 5;

// Radix Select cannot hold an empty value, and a bare sentinel could collide
// with a Project id, so every Project option carries its own prefix.
const NEW_VALUE = 'new';
const PROJECT_PREFIX = 'project:';

interface Props {
  /** The Project to append to, or null to record into a brand-new one. */
  value: string | null;
  onChange: (projectId: string | null) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * 「錄到哪裡」: the popup's opt-in for appending to an existing Project. The
 * default stays 新專案 so a stray click can never mix steps into finished work.
 * Renders nothing until the Library holds at least one Project, so a first-time
 * user sees no extra control.
 */
export default function RecordTargetPicker({ value, onChange, disabled = false, className }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
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
          const selected = value === null ? undefined : all.find((project) => project.id === value);
          if (value !== null && !selected) onChange(null);
          // A selection that fell out of the recent window stays listed so the trigger never renders blank.
          const recent = all.slice(0, RECORD_TARGET_RECENT_LIMIT);
          setProjects(selected && !recent.includes(selected) ? [...recent, selected] : recent);
        })
        .catch((error) => {
          // Fail closed to "new project only": a missing list must never block recording.
          console.warn('[howbeam] failed to read projects for the record target', error);
        });
    };
    // Which Series a Project is in is only a label here: a failed read leaves the labels off, never the list.
    const loadSeries = () => {
      void getAllSeries()
        .then((series) => {
          if (!active) return;
          const titles = new Map<string, string>();
          for (const [projectId, entry] of seriesByProject(series)) titles.set(projectId, seriesDisplayTitle(entry.title));
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
    // `onChange` is a setState in the caller; the list re-reads when the selection changes.
  }, [value, onChange]);

  if (projects.length === 0) return null;
  const selected = value === null ? undefined : projects.find((project) => project.id === value);

  return (
    <Select
      value={value === null ? NEW_VALUE : `${PROJECT_PREFIX}${value}`}
      onValueChange={(next) => onChange(next === NEW_VALUE ? null : next.slice(PROJECT_PREFIX.length))}
      disabled={disabled}
    >
      <SelectTrigger
        aria-label={t().popup.recordTarget}
        className={cn(
          'h-9 w-full gap-2 border-2 border-border bg-card px-3 text-sm font-bold text-foreground focus-ring focus-visible:border-border focus-visible:ring-0 data-[size=default]:h-9 dark:bg-card dark:hover:bg-secondary *:data-[slot=select-value]:flex-1',
          className,
        )}
      >
        {selected ? <FolderOpen aria-hidden="true" /> : <Plus aria-hidden="true" />}
        {/* Its own one-line content: the options wrap long titles, which a one-line trigger cannot. */}
        <SelectValue>
          {selected ? (
            <>
              {/* The trigger is one line; the tooltip keeps a long title reachable. */}
              <OverflowTooltip content={projectDisplayTitle(selected.title)}>
                <span className="min-w-0 flex-1 truncate">{projectDisplayTitle(selected.title)}</span>
              </OverflowTooltip>
              <span className="shrink-0 text-xs font-bold text-muted-foreground">{t().popup.recordTargetCount(selected.entryCount)}</span>
            </>
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
        {projects.map((project) => (
          <SelectItem key={project.id} value={`${PROJECT_PREFIX}${project.id}`} className="font-bold">
            <span className="flex min-w-0 flex-1 flex-col">
              <OverflowTooltip content={projectDisplayTitle(project.title)}>
                <span className="line-clamp-2 min-w-0 break-words">
                  {projectDisplayTitle(project.title)}
                </span>
              </OverflowTooltip>
              {seriesTitles.has(project.id) && (
                <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                  <Layers className="size-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{seriesTitles.get(project.id)}</span>
                </span>
              )}
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
