import { useRef, useState } from 'react';
import { Bookmark, ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/shared/utils';
import { t } from '@/lib/shared/i18n';

export interface SectionChipSection {
  id: string;
  title: string;
  /** 1-based step number the section begins at. */
  startStep: number;
}

interface Props {
  /** The section the step falls under; absent before the first section. */
  section?: SectionChipSection;
  /** 1-based number of the step on stage. */
  step: number;
  /** Present when a section can start at this step, i.e. it does not begin one already. */
  onStartSection?: () => void;
  onRenameSection?: (sectionId: string) => void;
  onDeleteSection?: (sectionId: string) => void | Promise<void>;
  disabled?: boolean;
}

const MENU_ITEM = 'flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-[13px] outline-none transition-colors focus-ring';

/** Where the step stands in the document, and the one place on stage to change that. The owner reports failures. */
export default function SectionChip({
  section,
  step,
  onStartSection,
  onRenameSection,
  onDeleteSection,
  disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** Set while the menu closes to open a dialog, which then owns focus. */
  const handingOffFocus = useRef(false);
  const manageable = Boolean(section && onRenameSection && onDeleteSection);
  const hasActions = Boolean(onStartSection) || manageable;
  const triggerDisabled = disabled || deleting || !hasActions;

  function handOff(action: () => void) {
    handingOffFocus.current = true;
    setOpen(false);
    action();
  }

  async function handleDelete() {
    if (!section || !onDeleteSection || deleting) return;
    setDeleting(true);
    setOpen(false);
    try {
      await onDeleteSection(section.id);
    } catch {
      // Callback owners decide how operation failures are presented.
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={triggerDisabled}
          aria-label={section ? t().editor.sections.current(section.title) : t().editor.sections.none}
          className={cn(
            'group flex h-7 min-w-0 max-w-[16rem] shrink-0 items-center gap-1 rounded-full border-2 px-2.5 text-xs font-bold outline-none transition-colors focus-ring',
            'disabled:cursor-default',
            section
              ? 'border-border bg-matcha text-on-accent hover:bg-matcha/80 data-[state=open]:bg-matcha/80'
              : 'border-dashed border-border bg-transparent text-muted-foreground hover:border-solid hover:bg-secondary hover:text-foreground data-[state=open]:border-solid data-[state=open]:bg-secondary data-[state=open]:text-foreground',
            (disabled || deleting) && 'opacity-50',
          )}
        >
          <Bookmark className="size-3 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">{section ? section.title : t().editor.sections.none}</span>
          {hasActions && (
            <ChevronDown
              className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
              strokeWidth={2.5}
              aria-hidden="true"
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="flex w-max min-w-40 max-w-64 flex-col p-0.5"
        onCloseAutoFocus={(event) => {
          // Returning focus to the chip would pull it out of the dialog's name field.
          if (handingOffFocus.current) event.preventDefault();
          handingOffFocus.current = false;
        }}
      >
        <div className="px-2 pt-1.5 pb-1">
          {/* The chip truncates; the menu is where a long title can be read whole. */}
          <p className="text-[13px] font-bold break-words text-foreground">
            {section ? section.title : t().editor.sections.none}
          </p>
          <p className="text-xs text-muted-foreground">
            {section
              ? section.startStep === step
                ? t().editor.sections.startsHere
                : t().editor.sections.startsAt(section.startStep)
              : t().editor.sections.noneHint}
          </p>
        </div>
        {onStartSection && (
          <button
            type="button"
            onClick={() => handOff(onStartSection)}
            className={cn(MENU_ITEM, 'text-foreground hover:bg-secondary')}
          >
            <Plus className="size-3.5 shrink-0" aria-hidden="true" />
            {t().editor.sections.addAt(step)}
          </button>
        )}
        {manageable && section && (
          <>
            <div role="separator" className="mx-1.5 my-0.5 border-t-2 border-border-soft" />
            <button
              type="button"
              onClick={() => handOff(() => onRenameSection?.(section.id))}
              className={cn(MENU_ITEM, 'text-foreground hover:bg-secondary')}
            >
              <Pencil className="size-3.5 shrink-0" aria-hidden="true" />
              {t().editor.sections.rename}
            </button>
            <button
              type="button"
              onClick={() => void handleDelete()}
              className={cn(MENU_ITEM, 'text-danger hover:bg-danger-soft')}
            >
              <Trash2 className="size-3.5 shrink-0" aria-hidden="true" />
              {t().editor.sections.delete}
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
