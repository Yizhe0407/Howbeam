import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { DashedOutline } from '@/components/ui/dashed-outline';
import { Input } from '@/components/ui/input';
import { buttonVariants } from '@/components/ui/button';
import InlineAlert from '@/components/shared/InlineAlert';
import { reportError } from '@/components/shared/report-error';
import { PROJECT_TAG_LIMITS, sanitizeProjectTag } from '@/lib/storage/project-tag-model';
import { getProjectSummaries } from '@/lib/storage/project-repository';
import { cn } from '@/lib/shared/utils';
import { tagHueClass } from '@/lib/shared/tag-hue';
import { intlLocale, t } from '@/lib/shared/i18n';

interface Props {
  open: boolean;
  selectedTags: readonly string[];
  onOpenChange: (open: boolean) => void;
  /** Adds one tag, applied immediately like the inline tag chips behind this
   * dialog. An operation rather than a whole list, so a tag another tab added
   * meanwhile is never dropped by this dialog's older copy of the list. */
  onAddTag: (tag: string) => void | Promise<void>;
}

/** Add-only: removing a tag belongs to the inline chips on the stage behind this dialog, avoiding two paths to the same write. */
export default function TagSelectDialog({
  open,
  selectedTags,
  onOpenChange,
  onAddTag,
}: Props) {
  const [customInput, setCustomInput] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [usedTags, setUsedTags] = useState<readonly string[]>([]);

  useEffect(() => {
    if (!open) return;
    setCustomInput('');
    setSaveError(null);
    let stale = false;
    // Project summaries are denormalized rows (no step cursor, no screenshot Blob), so reading
    // them on open to suggest previously-used tags is cheap.
    void getProjectSummaries()
      .then((summaries) => {
        if (stale) return;
        setUsedTags([...new Set(summaries.flatMap((summary) => summary.tags))]
          .sort((first, second) => first.localeCompare(second, intlLocale())));
      })
      .catch((loadFailure) => {
        // Suggestions are a shortcut, not the feature, so a failed read isn't a save failure.
        console.warn('[howbeam] failed to read previously used project tags', loadFailure);
      });
    return () => { stale = true; };
  }, [open]);

  // `selectedTags` stays the only source of truth (no local mirror), so a refused or failed
  // write can never leave this dialog showing an unsaved tag.
  async function addTag(tag: string) {
    if (selectedTags.includes(tag) || selectedTags.length >= PROJECT_TAG_LIMITS.maxTags) return;
    setSaveError(null);
    try {
      await onAddTag(tag);
    } catch (saveFailure) {
      setSaveError(reportError('[howbeam] failed to update project tags', saveFailure, t().editor.tags.saveFailed));
    }
  }

  function handleAddCustom() {
    const nextTag = sanitizeProjectTag(customInput);
    setCustomInput('');
    if (!nextTag) return;
    void addTag(nextTag);
  }

  const limitReached = selectedTags.length >= PROJECT_TAG_LIMITS.maxTags;
  const suggestions = usedTags.filter((tag) => !selectedTags.includes(tag));
  const customTag = sanitizeProjectTag(customInput);
  const canAddCustom = Boolean(customTag) && !selectedTags.includes(customTag) && !limitReached;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showClose={false} className="app-scrollbar max-h-[calc(100vh-32px)] w-[min(360px,calc(100vw-32px))] overflow-y-auto p-5">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle>{t().editor.tags.dialogTitle}</DialogTitle>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label={t().editor.tags.close}
              className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors focus-ring hover:bg-secondary hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
          <DialogDescription className="sr-only">{t().editor.tags.dialogDescription}</DialogDescription>

          {saveError && <InlineAlert>{saveError}</InlineAlert>}

          <div className="flex items-center gap-2">
            <Input
              type="text"
              value={customInput}
              maxLength={PROJECT_TAG_LIMITS.maxTagLength}
              onChange={(e) => setCustomInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddCustom();
                }
              }}
              placeholder={t().editor.tags.inputPlaceholder}
              aria-label={t().editor.tags.inputLabel}
              className="min-w-0 flex-1"
            />
            <button
              type="button"
              onClick={handleAddCustom}
              disabled={!canAddCustom}
              aria-label={t().editor.tags.add}
              className={cn(buttonVariants({ size: 'icon' }), 'size-10')}
            >
              <Plus className="size-4 stroke-[2.5]" />
            </button>
          </div>

          {limitReached && (
            <p className="text-xs text-muted-foreground">
              {t().editor.tags.limitReached(PROJECT_TAG_LIMITS.maxTags)}
            </p>
          )}

          {selectedTags.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-xs font-bold text-muted-foreground">{t().editor.tags.current}</span>
              {/* Shown, not editable: otherwise a user could type an already-applied tag and see nothing happen. */}
              <div className="flex flex-wrap gap-2">
                {selectedTags.map((tag) => (
                  <Badge key={tag} variant="tag" className={cn('max-w-full select-none', tagHueClass(tag))}>
                    <span className="min-w-0 truncate">{tag}</span>
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {suggestions.length > 0 && !limitReached && (
            <div className="flex flex-col gap-2">
              <span className="text-xs font-bold text-muted-foreground">{t().editor.tags.used}</span>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((tag) => (
                  <Badge key={tag} asChild variant="tagEditableAvailable" className="max-w-full select-none">
                    <button
                      type="button"
                      onClick={() => void addTag(tag)}
                      aria-label={t().editor.tags.addTag(tag)}
                      className="min-w-0"
                    >
                      <DashedOutline radius="full" outset={2} hideOnHover />
                      <span className="min-w-0 truncate">{tag}</span>
                    </button>
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
