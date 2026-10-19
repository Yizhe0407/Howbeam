import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/shared/utils';

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
  className?: string;
}

/**
 * Owns its draft while focused; an empty, unchanged, or rejected commit
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
  className,
}: Props) {
  const committed = value || fallback;
  const [draft, setDraft] = useState(committed);
  const [editing, setEditing] = useState(false);
  const committing = useRef(false);
  // `blur()` dispatches focusout synchronously before React re-renders, so
  // this ref is what tells the blur commit that Escape already cancelled it.
  const cancelled = useRef(false);

  // An external rename (undo, another tab, a failed write reloading the project)
  // wins whenever the user is not mid-edit.
  useEffect(() => {
    if (!editing) setDraft(committed);
  }, [committed, editing]);

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

  return (
    <input
      aria-label={label}
      value={draft}
      maxLength={maxLength}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => {
        cancelled.current = false;
        setEditing(true);
      }}
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
      className={cn('bg-transparent outline-none', className)}
    />
  );
}
