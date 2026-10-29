import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Video } from 'lucide-react';
import { DndContext, closestCenter } from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { entryId, type StepEntry } from '@/lib/storage/models';
import { railRows, type ProjectSection, type RailRow } from '@/lib/project/project-sections';
import {
  horizontalListModifiers,
  useSortableReorder,
  verticalListModifiers,
} from '@/lib/editor/dnd';
import { t } from '@/lib/shared/i18n';
import { cn } from '@/lib/shared/utils';
import { useAutoHideScrollbar } from '@/lib/editor/use-auto-hide-scrollbar';
import EntryThumbnail from './EntryThumbnail';
import SortableItem, { SortableOverlay, StaticHandle } from './SortableItem';
import ProjectSectionHeading from './ProjectSectionHeading';


const SEAM_PILL = 'relative flex h-[18px] min-w-0 scale-90 items-center gap-1 whitespace-nowrap rounded-full border-2 border-border px-2 text-[11px] leading-none font-bold text-on-accent opacity-0 shadow-sm outline-none transition-[transform,opacity] duration-150 ease-out group-hover/slot:scale-100 group-hover/slot:opacity-100 [li:hover+li_&]:scale-100 [li:hover+li_&]:opacity-100 group-focus-within/slot:scale-100 group-focus-within/slot:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:pointer-events-none motion-reduce:transition-none';

/**
 * The seam between two steps. It takes no room of its own: a zero-height row
 * whose hit area straddles the existing gap, so the list keeps its density.
 * Invisible until it, or the step above it, is hovered or focused; then a
 * dashed line with its actions floats over the seam: record new steps here,
 * or start a section here.
 */
function SeamActions({
  afterStep,
  disabled,
  onInsert,
  onStartSection,
}: {
  afterStep: number;
  disabled: boolean;
  onInsert?: () => void;
  onStartSection?: () => void;
}) {
  return (
    <li className="relative z-10 -mt-3 hidden h-0 shrink-0 lg:block">
      {/* -mt-3 takes back the list gap before this row, so a 16px slot centred on the 12px gap below sits at -top-0.5.
          The pills share the rail's width and truncate rather than overflow it, whatever a locale's label length. */}
      <div className="group/slot absolute inset-x-0 -top-0.5 flex h-4 items-center justify-center gap-1 px-2">
        <span
          aria-hidden="true"
          className="absolute inset-x-2 top-1/2 origin-center scale-x-0 border-t-2 border-dashed border-border opacity-0 transition-[transform,opacity] duration-200 ease-out group-hover/slot:scale-x-100 group-hover/slot:opacity-100 [li:hover+li_&]:scale-x-100 [li:hover+li_&]:opacity-100 group-focus-within/slot:scale-x-100 group-focus-within/slot:opacity-100 motion-reduce:transition-none"
        />
        {onInsert && (
          <button
            type="button"
            disabled={disabled}
            onClick={onInsert}
            aria-label={t().editor.rail.insertAfter(afterStep)}
            className={cn(SEAM_PILL, 'bg-sora')}
          >
            <Plus className="size-3 shrink-0" strokeWidth={3} aria-hidden="true" /><span className="truncate">{t().editor.rail.insertHere}</span>
          </button>
        )}
        {onStartSection && (
          <button
            type="button"
            disabled={disabled}
            onClick={onStartSection}
            aria-label={t().editor.sections.addAt(afterStep + 1)}
            className={cn(SEAM_PILL, 'bg-matcha')}
          >
            <Plus className="size-3 shrink-0" strokeWidth={3} aria-hidden="true" /><span className="truncate">{t().editor.sections.addShort}</span>
          </button>
        )}
      </div>
    </li>
  );
}

/** Sortable ids for the rail's rows; entry and section ids are separate id spaces, so each gets its kind. */
function rowId(row: RailRow): string {
  return `${row.kind}:${row.id}`;
}

function LazyRailPreview({ eager, children }: { eager: boolean; children: ReactNode }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(eager);

  useEffect(() => {
    if (eager || visible) {
      setVisible(true);
      return;
    }
    const element = host.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: '320px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [eager, visible]);

  return (
    <div
      ref={host}
      aria-busy={!visible}
      className="relative size-full overflow-hidden"
    >
      {visible ? children : <span className="sr-only">{t().editor.rail.thumbnailPending}</span>}
    </div>
  );
}

// Sits on top of a screenshot, so it wears the same solid sticker chip as the step number.
const RAIL_HANDLE = 'size-6 rounded-full border-2 border-border bg-card text-foreground hover:bg-secondary [&_svg]:size-3.5';

/** An entry's screenshot with its step number, as the rail and a dragged entry's copy show it. */
function RailThumbnail({ entry, number, active }: { entry: StepEntry; number: number; active: boolean }) {
  return (
    <div className="pointer-events-none relative z-[1] aspect-[16/9] w-full overflow-hidden rounded-sm border-2 border-border bg-secondary">
      <LazyRailPreview eager={active}>
        <EntryThumbnail
          entry={entry}
          alt=""
          fit="cover"
          badges={false}
          loading="lazy"
          decoding="async"
          className="size-full"
        />
      </LazyRailPreview>
      <span className={cn(
        'absolute top-1.5 left-1.5 z-30 flex h-6 min-w-6 items-center justify-center rounded-full border-2 border-border px-1 text-xs font-bold tabular-nums transition-colors',
        active ? 'bg-selected text-on-accent' : 'bg-card text-foreground',
      )}>
        {number}
      </span>
    </div>
  );
}

interface Props {
  entries: StepEntry[];
  selectedEntryId: string | null;
  sections?: readonly ProjectSection[];
  onSelect: (id: string) => void;
  /** Asks for the rename dialog; the rail never edits a title itself. */
  onRenameSection?: (sectionId: string) => void;
  onDeleteSection?: (sectionId: string) => Promise<void>;
  /** Asks for the add-section dialog at an entry that does not begin a section yet. */
  onStartSection?: (startEntryId: string) => void;
  /** Gets the rail as the drop left it: entries in their new order, each section heading where it was left. */
  onReorder: (rows: RailRow[]) => Promise<void>;
  /** Starts a continuation; `afterEntryId` inserts after that entry, omitted appends at the end. */
  onContinueRecording?: (afterEntryId?: string) => void;
  reorderDisabled?: boolean;
}

export default function StepRail({
  entries,
  selectedEntryId,
  sections = [],
  onSelect,
  onRenameSection,
  onDeleteSection,
  onStartSection,
  onReorder,
  onContinueRecording,
  reorderDisabled = false,
}: Props) {
  const labelled = Boolean(onRenameSection && onDeleteSection);
  const rows = railRows(entries, labelled ? sections : []);
  const { sensors, accessibility, handlers, itemIds, overlayHost, setOverlayHost, previewPositionOf } = useSortableReorder(
    rows,
    rowId,
    onReorder,
    {
      disabled: reorderDisabled,
      itemNoun: t().sortable.stepNoun,
      logLabel: '[howbeam] failed to reorder project entries',
      isFixed: (row) => row.kind === 'section',
    },
  );
  const entryById = new Map(entries.map((entry) => [entryId(entry), entry]));
  const sectionById = new Map(sections.map((section) => [section.id, section]));
  const selectedItem = useRef<HTMLButtonElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const scrollbar = useAutoHideScrollbar<HTMLUListElement>();
  const sectionByStartId = new Map(sections.map((section) => [section.startEntryId, section]));
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 1024px)').matches : true,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(min-width: 1024px)');
    const apply = () => setIsDesktop(query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    selectedItem.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [entries.length, selectedEntryId]);

  // Ref avoids rebinding the window listener each render; written in an effect
  // (not during render) since a concurrent render can be discarded.
  const navigation = useRef({ entries, isDesktop, onSelect, selectedEntryId });
  useEffect(() => {
    navigation.current = { entries, isDesktop, onSelect, selectedEntryId };
  });

  // Arrow-key navigation across the rail, skipped while typing in a field elsewhere on the page.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;
      const activeElement = document.activeElement as HTMLElement | null;
      // Scoped to the rail so arrow keys used by other editor controls don't switch the entry.
      if (!activeElement || !railRef.current?.contains(activeElement)) return;
      const tag = activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || activeElement.isContentEditable) return;
      const { entries, isDesktop, onSelect, selectedEntryId } = navigation.current;
      const previousKey = isDesktop ? 'ArrowUp' : 'ArrowLeft';
      const nextKey = isDesktop ? 'ArrowDown' : 'ArrowRight';
      if (e.key !== previousKey && e.key !== nextKey) return;
      const idx = entries.findIndex((entry) => entryId(entry) === selectedEntryId);
      if (idx === -1) return;
      const next = entries[e.key === previousKey ? idx - 1 : idx + 1];
      if (!next) return;
      e.preventDefault();
      onSelect(entryId(next));
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  return (
    <nav
      ref={railRef}
      aria-label={t().editor.rail.label}
      className="fixed inset-x-0 bottom-0 z-30 flex h-[var(--step-rail-height,8rem)] shrink-0 flex-col border-t-2 border-border bg-card lg:static lg:z-auto lg:my-6 lg:ml-6 lg:h-auto lg:max-h-[calc(100%-3rem)] lg:min-h-0 lg:w-[200px] lg:min-w-[200px] lg:shrink-0 lg:self-start lg:basis-[200px] lg:rounded-md lg:border-2"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-3.5 pt-3 pb-2 text-xs font-bold text-muted-foreground">
        <span>{t().editor.rail.count(entries.length)}</span>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        {...handlers}
        accessibility={accessibility}
        modifiers={isDesktop ? verticalListModifiers : horizontalListModifiers}
      >
        <SortableContext
          items={itemIds}
          strategy={isDesktop ? verticalListSortingStrategy : horizontalListSortingStrategy}
        >
          <ul
            {...scrollbar}
            aria-label={t().editor.rail.listLabel}
            className="app-scrollbar-autohide flex flex-1 flex-row gap-3 overflow-x-auto px-2 pb-2 lg:min-h-0 lg:flex-col lg:gap-3 lg:overflow-x-visible lg:overflow-y-auto lg:px-2 lg:pb-2"
          >
            {rows.map((row) => {
              if (row.kind === 'section') {
                const section = sectionById.get(row.id);
                if (!section || !onRenameSection || !onDeleteSection) return null;
                return (
                  // The mobile rail is a fixed-height strip, so a heading sits beside its first step there instead of above it.
                  <SortableItem key={rowId(row)} id={rowId(row)} fixed className="w-36 shrink-0 self-center lg:w-auto lg:self-auto">
                    {() => (
                      <ProjectSectionHeading
                        section={section}
                        disabled={reorderDisabled}
                        onRename={onRenameSection}
                        onDelete={onDeleteSection}
                      />
                    )}
                  </SortableItem>
                );
              }
              const entry = entryById.get(row.id);
              if (!entry) return null;
              const id = row.id;
              const index = entries.indexOf(entry);
              const nextEntry = entries[index + 1];
              const active = id === selectedEntryId;
              const number = previewPositionOf(rowId(row));
              return (
                <Fragment key={rowId(row)}>
                <SortableItem
                  id={rowId(row)}
                  disabled={reorderDisabled}
                  overlayHost={overlayHost}
                  className="w-32 shrink-0 [content-visibility:auto] [contain-intrinsic-size:128px_78px] lg:w-full lg:min-w-0"
                  handleClassName={RAIL_HANDLE}
                >
                  {(handle, overlay) => (
                    <div
                      data-active={active || undefined}
                      // The row is the thumbnail itself, with no plate around it, so every row's edge is its ink border and the seams between rows stay even.
                      className="group relative flex w-32 min-w-0 shrink-0 cursor-pointer items-center rounded-sm lg:w-auto lg:shrink"
                    >
                      <button
                        ref={active ? selectedItem : undefined}
                        type="button"
                        onClick={() => onSelect(id)}
                        aria-label={t().editor.rail.openStep(index + 1)}
                        aria-current={active ? 'step' : undefined}
                        className="absolute inset-0 z-0 rounded-sm outline-none focus-ring"
                      />
                      {active && (
                        <span
                          aria-hidden="true"
                          data-howbeam-selected-step-outline
                          className="howbeam-selected-step-outline pointer-events-none absolute inset-0 z-10 rounded-sm border-2"
                        />
                      )}
                      <RailThumbnail entry={entry} number={number} active={active} />
                      {/* Always rendered: a hover-only handle is invisible on touch; rests dimmed to not compete with the thumbnail. */}
                      <span className="absolute top-1.5 right-1.5 z-20 opacity-80 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        {handle}
                      </span>
                      {overlay && createPortal(
                        <div className="relative flex size-full items-center rounded-sm">
                          <RailThumbnail entry={entry} number={number} active={active} />
                          <span className="absolute top-1.5 right-1.5 z-20">
                            <StaticHandle className={RAIL_HANDLE} />
                          </span>
                        </div>,
                        overlay,
                      )}
                    </div>
                  )}
                </SortableItem>
                {/* The last seam is the 接續錄製 button below the list. */}
                {nextEntry && (onContinueRecording || onStartSection) && (
                  <SeamActions
                    afterStep={index + 1}
                    disabled={reorderDisabled}
                    onInsert={onContinueRecording && (() => onContinueRecording(id))}
                    onStartSection={
                      onStartSection && !sectionByStartId.has(entryId(nextEntry))
                        ? () => onStartSection(entryId(nextEntry))
                        : undefined
                    }
                  />
                )}
                </Fragment>
              );
            })}
          </ul>
        </SortableContext>
        <SortableOverlay onHost={setOverlayHost} />
      </DndContext>
      {onContinueRecording && (
        <button
          type="button"
          onClick={() => onContinueRecording()}
          disabled={reorderDisabled}
          className="mx-2 mt-1 mb-2 hidden h-9 shrink-0 items-center justify-center gap-1.5 rounded-md border-2 border-border bg-card text-xs leading-none font-bold text-foreground outline-none transition-colors focus-ring hover:bg-secondary disabled:pointer-events-none disabled:opacity-40 lg:flex"
        >
          <Video className="size-3.5" />{t().editor.rail.continueRecording}
        </button>
      )}
    </nav>
  );
}
