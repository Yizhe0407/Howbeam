import { useEffect, useMemo, useState } from 'react';
import { entryRasterInput, entryRasterKey, type EntryRasterInput, type EntryRasterOptions } from '@/lib/export/entry-render';
import { redactionKey } from '@/lib/media/redaction-render';
import { peekEntryPreview, requestEntryPreview } from '@/lib/preview/entry-preview-cache';
import type { StepEntry } from '@/lib/storage/models';

export interface EntryPreviewOptions {
  /** Downscale to at most this many pixels wide; omitted keeps the screenshot's full size. */
  maxPixelWidth?: number;
  /** False leaves out a group's order badges, for previews too small to read them. */
  badges?: boolean;
}

interface Shown {
  input: EntryRasterInput;
  key: string;
  blob: Blob | null;
}

/** Whether an earlier preview of the same screenshot hides at least what the
 * new one must, so it can stay on screen while the new one is made. */
function hidesAtLeast(previous: EntryRasterInput, next: EntryRasterInput): boolean {
  if (previous.screenshot !== next.screenshot) return false;
  if (previous.privacyReviewRequired) return true;
  if (next.privacyReviewRequired) return false;
  if (JSON.stringify(previous.crop) !== JSON.stringify(next.crop)) return false;
  const hidden = new Set(previous.redactions.map(redactionKey));
  return next.redactions.every((redaction) => hidden.has(redactionKey(redaction)));
}

/**
 * The finished image of `entry` (see lib/preview/entry-preview-cache), or null
 * while there is nothing safe to show yet. While a changed entry is being
 * re-rendered its previous image stays up, but only if it hides at least what
 * the new one hides; otherwise nothing is shown until the new one is ready.
 * Nothing is requested while `enabled` is false.
 */
export function useEntryPreview(
  entry: StepEntry,
  { maxPixelWidth, badges = true }: EntryPreviewOptions,
  enabled = true,
): Blob | null {
  const input = useMemo(() => entryRasterInput(entry), [entry]);
  const options = useMemo<EntryRasterOptions>(
    () => ({ format: 'image/jpeg', maxPixelWidth, badges }),
    [maxPixelWidth, badges],
  );
  // Keyed on content, not on the entry object: reloading the project after an
  // unrelated edit (a title) gives new objects with the same pixels.
  const key = useMemo(() => entryRasterKey(input, options), [input, options]);
  const [shown, setShown] = useState<Shown | null>(null);

  const ready = peekEntryPreview(input.screenshot, key);

  // Held for as long as this view shows it, ready or not, so it is not evicted from under the view.
  useEffect(() => {
    if (!enabled) return undefined;
    return requestEntryPreview(input, key, options, (blob) => setShown({ input, key, blob }));
  }, [enabled, input, key, options]);

  if (ready) return ready;
  if (!shown) return null;
  if (shown.key === key && shown.input.screenshot === input.screenshot) return shown.blob;
  return shown.blob && hidesAtLeast(shown.input, input) ? shown.blob : null;
}
