import { useEffect, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { cn } from '@/lib/shared/utils';
import OverflowTooltip from './OverflowTooltip';

interface Props {
  value: string;
  /** Commit the trimmed, changed title. Rejecting reverts the field. */
  onCommit: (title: string) => void | Promise<void>;
  /** Reported when a commit rejects, so the owner can surface the reason. */
  onCommitError?: (error: unknown) => void;
  /** Shown when `value` is empty. Also what an emptied field reverts to. */
  fallback: string;
  label: string;
  maxLength: number;
  disabled?: boolean;
  /** How many lines the title shows before it is cut off; the tooltip keeps the rest reachable. */
  lines?: 1 | 2;
}

/**
 * A title that reads as plain text, shows a soft frame and a pencil on hover,
 * and becomes a real field when clicked. It owns all three looks, so every
 * title edits the same way; the heading around it supplies the typography.
 * Owns its draft while editing; an empty, unchanged, or rejected commit
 * reverts the field, so what's displayed always matches what's stored.
 */
export default function EditableTitle({
  value,
  onCommit,
  onCommitError,
  fallback,
  label,
  maxLength,
  disabled = false,
  lines = 1,
}: Props) {
  const committed = value || fallback;
  const [draft, setDraft] = useState(committed);
  const [editing, setEditing] = useState(false);
  const committing = useRef(false);
  const field = useRef<HTMLTextAreaElement | null>(null);
  // `blur()` dispatches focusout synchronously before React re-renders, so
  // this ref is what tells the blur commit that Escape already cancelled it.
  const cancelled = useRef(false);

  // An external rename (undo, another tab, a failed write reloading the project)
  // wins whenever the user is not mid-edit.
  useEffect(() => {
    if (!editing) setDraft(committed);
  }, [committed, editing]);

  useEffect(() => {
    const element = field.current;
    if (!editing || !element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, [editing]);

  async function commit() {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const next = draft.trim();
    if (!next || next === committed) {
      setDraft(committed);
      return;
    }
    if (committing.current) return;
    committing.current = true;
    try {
      await onCommit(next);
    } catch (commitError) {
      setDraft(committed);
      onCommitError?.(commitError);
    } finally {
      committing.current = false;
    }
  }

  const frame = cn(
    'group relative flex min-w-0 max-w-full items-center gap-1.5 rounded-md border-2 px-1 py-0.5 transition-colors focus-ring-within',
    editing && 'border-border bg-background',
    !editing && 'border-transparent',
    !editing && !disabled && 'hover:bg-muted',
    !editing && disabled && 'opacity-70',
  );

  if (!editing) {
    return (
      <div className={frame}>
        {/* The full title, for when the line limit cuts it off. */}
        <OverflowTooltip content={committed}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              cancelled.current = false;
              setEditing(true);
            }}
            // The ::after stretches the click target over the whole frame, pencil included,
            // while the button's own box stays the text so the tooltip can tell it's clipped.
            className={cn(
              'min-w-0 cursor-text text-left outline-none after:absolute after:inset-0 disabled:cursor-default',
              lines === 1 ? 'truncate' : 'line-clamp-2 break-words',
            )}
          >
            <span className="sr-only">{label} </span>
            {committed}
          </button>
        </OverflowTooltip>
        {!disabled && (
          <Pencil
            className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-has-[:focus-visible]:opacity-100"
            aria-hidden="true"
          />
        )}
      </div>
    );
  }

  return (
    <div className={frame}>
      <textarea
        ref={field}
        aria-label={label}
        value={draft}
        rows={1}
        maxLength={maxLength}
        disabled={disabled}
        // A title is one line; a pasted line break becomes a space.
        onChange={(event) => setDraft(event.target.value.replace(/\s*[\r\n]+\s*/g, ' '))}
        onBlur={() => {
          setEditing(false);
          void commit();
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            cancelled.current = true;
            setDraft(committed);
            setEditing(false);
            event.currentTarget.blur();
          }
        }}
        className={cn(
          'min-w-12 max-w-full resize-none bg-transparent outline-none [field-sizing:content]',
          lines === 1 && 'truncate',
        )}
      />
    </div>
  );
}
