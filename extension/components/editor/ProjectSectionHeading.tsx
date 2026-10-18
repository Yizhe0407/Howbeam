import { useRef, useState } from 'react';
import { Ellipsis, Pencil, Trash2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { t } from '@/lib/shared/i18n';

interface ProjectSectionHeadingSection {
  id: string;
  title: string;
  startEntryId: string;
}

export interface ProjectSectionHeadingProps {
  section: ProjectSectionHeadingSection;
  /** Disables controls when the parent cannot accept a section action. */
  disabled?: boolean;
  /** Asks the owner to open the rename dialog. */
  onRename: (sectionId: string) => void;
  onDelete: (sectionId: string) => void | Promise<void>;
}

/** A one-line section label; renaming and deleting live in its menu. The owner reports failures. */
function ProjectSectionHeading({
  section,
  disabled = false,
  onRename,
  onDelete,
}: ProjectSectionHeadingProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteInFlight = useRef(false);
  /** Set while the menu closes to open the rename dialog, which then owns focus. */
  const handingOffFocus = useRef(false);
  const controlsDisabled = disabled || deleting;

  async function handleDelete() {
    if (controlsDisabled || deleteInFlight.current) return;
    deleteInFlight.current = true;
    setDeleting(true);
    setMenuOpen(false);
    try {
      await onDelete(section.id);
    } catch {
      // Callback owners decide how operation failures are presented.
    } finally {
      deleteInFlight.current = false;
      setDeleting(false);
    }
  }

  return (
    <section
      aria-label={t().editor.sections.label(section.title)}
      className="flex min-w-0 items-center gap-1.5 pt-1.5 pb-0.5 pl-1"
    >
      <span aria-hidden="true" className="w-1 self-stretch rounded-full bg-matcha" />
      <h2 title={section.title} className="min-w-0 flex-1 truncate text-[13px] leading-6 font-bold text-foreground">
        {section.title}
      </h2>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={controlsDisabled}
            aria-label={t().editor.sections.actionsLabel}
            className="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-transparent text-muted-foreground outline-none transition-colors focus-ring hover:border-border hover:bg-card hover:text-foreground disabled:pointer-events-none disabled:opacity-40 data-[state=open]:border-border data-[state=open]:bg-card data-[state=open]:text-foreground"
          >
            <Ellipsis className="size-3.5" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={4}
          className="flex w-36 flex-col p-0.5"
          onCloseAutoFocus={(event) => {
            // Returning focus to the menu button would pull it out of the dialog's name field.
            if (handingOffFocus.current) event.preventDefault();
            handingOffFocus.current = false;
          }}
        >
          <button
            type="button"
            onClick={() => {
              handingOffFocus.current = true;
              setMenuOpen(false);
              onRename(section.id);
            }}
            className="flex h-8 items-center gap-2 rounded-sm px-2 text-[13px] text-foreground outline-none transition-colors focus-ring hover:bg-secondary"
          >
            <Pencil className="size-3.5" aria-hidden="true" />{t().common.rename}
          </button>
          <button
            type="button"
            onClick={() => void handleDelete()}
            className="flex h-8 items-center gap-2 rounded-sm px-2 text-[13px] text-danger outline-none transition-colors focus-ring hover:bg-danger-soft"
          >
            <Trash2 className="size-3.5" aria-hidden="true" />{t().editor.sections.delete}
          </button>
        </PopoverContent>
      </Popover>
    </section>
  );
}

export default ProjectSectionHeading;
