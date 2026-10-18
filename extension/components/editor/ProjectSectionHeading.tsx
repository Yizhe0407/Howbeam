import { useId, useRef, useState } from 'react';
import { Ellipsis, Pencil, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { t } from '@/lib/shared/i18n';

/** A parent-owned action that may complete synchronously or asynchronously. */
type MaybePromise = void | Promise<void>;

interface ProjectSectionHeadingSection {
  id: string;
  title: string;
  startEntryId: string;
}

export interface ProjectSectionHeadingProps {
  section: ProjectSectionHeadingSection;
  /** Disables controls when the parent cannot accept a section action. */
  disabled?: boolean;
  onRename: (sectionId: string, title: string) => MaybePromise;
  onDelete: (sectionId: string) => MaybePromise;
}

export interface SectionTitleFormProps {
  initialTitle?: string;
  disabled?: boolean;
  /** Resolves once the title is stored; a rejection keeps the field open (the owner reports it). */
  onSubmit: (title: string) => MaybePromise;
  onCancel: () => void;
}

const MAX_TITLE_LENGTH = 200;

function normalizeTitle(value: string): string {
  return value.trim().slice(0, MAX_TITLE_LENGTH);
}

/** The one field for naming a section, used both to add one and to rename one. */
export function SectionTitleForm({ initialTitle = '', disabled = false, onSubmit, onCancel }: SectionTitleFormProps) {
  const [draft, setDraft] = useState(initialTitle);
  const [emptyTitle, setEmptyTitle] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Escape and a successful save unmount the field; the blur that follows must not act again.
  const settled = useRef(false);
  const inputId = useId();
  const noteId = useId();
  const busy = disabled || submitting;

  function cancel() {
    if (settled.current) return;
    settled.current = true;
    onCancel();
  }

  async function submit() {
    if (busy || settled.current) return;
    const title = normalizeTitle(draft);
    if (!title) {
      setEmptyTitle(true);
      return;
    }
    if (title === initialTitle) {
      cancel();
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(title);
      settled.current = true;
    } catch {
      // The owner reports the failure; the field stays open so nothing typed is lost.
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-1 pt-1"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={inputId} className="sr-only">{t().editor.sections.nameLabel}</label>
      <Input
        id={inputId}
        type="text"
        autoFocus
        value={draft}
        maxLength={MAX_TITLE_LENGTH}
        disabled={busy}
        aria-invalid={emptyTitle || undefined}
        aria-describedby={noteId}
        placeholder={t().editor.sections.nameLabel}
        onChange={(event) => {
          setDraft(event.target.value);
          if (emptyTitle) setEmptyTitle(false);
        }}
        onBlur={() => {
          // Leaving an empty field means the user changed their mind, never an empty name.
          if (!normalizeTitle(draft)) cancel();
          else void submit();
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
          } else if (event.key === 'Enter') {
            event.preventDefault();
            void submit();
          }
        }}
        className="h-8 px-2 text-[13px]"
      />
      {emptyTitle ? (
        <p id={noteId} role="alert" className="px-1 pb-0.5 text-[11px] font-bold text-danger">
          {t().editor.sections.emptyName}
        </p>
      ) : (
        <p id={noteId} className="px-1 pb-0.5 text-center text-[11px] text-muted-foreground">
          {t().editor.sections.inputHint}
        </p>
      )}
    </form>
  );
}

/** A one-line section label; renaming and deleting live in its menu. The owner reports failures. */
function ProjectSectionHeading({
  section,
  disabled = false,
  onRename,
  onDelete,
}: ProjectSectionHeadingProps) {
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteInFlight = useRef(false);
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

  if (editing) {
    return (
      <section aria-label={t().editor.sections.label(section.title)} className="pt-1">
        <SectionTitleForm
          initialTitle={section.title}
          disabled={disabled}
          onSubmit={async (title) => {
            await onRename(section.id, title);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      </section>
    );
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
        <PopoverContent align="end" sideOffset={4} className="flex w-36 flex-col p-0.5">
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              setEditing(true);
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
