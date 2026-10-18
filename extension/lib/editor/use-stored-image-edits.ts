import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getEntryCrop,
  getEntryImageEdits,
  getEntryImageOwner,
  getEntryPrivacyState,
  type StepEntry,
} from '@/lib/storage/models';
import {
  StepImageEditConflictError,
  StepUpdateConflictError,
} from '@/lib/storage/step-repository';
import { subscribeProjectsChanged } from '@/lib/storage/change-notifier';
import { splitItems, toItems, type ImageEditItem } from './image-edit-items';
import { ImageEditSessionConflict, useImageEditSession } from './image-edit-session';
import { isEntryImageStale, loadLatestEntry, saveEntryImageEdits } from './save-entry-image-edits';

/** Everything stored on an entry's image, as the editor's item list. */
function itemsOf(entry: StepEntry): ImageEditItem[] {
  return toItems(
    getEntryPrivacyState(entry).redactions,
    getEntryImageEdits(entry),
    getEntryCrop(entry),
  );
}

const imageEditRevisionOf = (entry: StepEntry): number =>
  getEntryImageOwner(entry).imageEditRevision ?? 0;
const captureRevisionOf = (entry: StepEntry): number =>
  getEntryImageOwner(entry).captureRevision ?? 0;

/**
 * The image editor's draft and its stored copy: edits live in a session draft
 * (instant, with undo/redo) saved behind it against the revision it builds on,
 * and an untouched draft follows saves made in other tabs.
 */
export function useStoredImageEdits(
  openedEntry: StepEntry,
  /** Called after another tab's saved edits replaced the draft. */
  onAdoptedElsewhere: () => void,
) {
  /** The entry as last read from storage: replaced when another tab changes this image. */
  const [entry, setEntry] = useState(openedEntry);
  const entryRef = useRef(entry);
  /** The stored image edit revision the draft builds on; every save must replace exactly it. */
  const revisionRef = useRef(imageEditRevisionOf(openedEntry));
  const [initialItems] = useState(() => itemsOf(openedEntry));
  /** The masks still wait for the person to confirm them (after a retake, or repaired metadata). */
  const [reviewRequired, setReviewRequired] = useState(
    () => getEntryPrivacyState(openedEntry).reviewRequired,
  );
  /** Set only while a confirming save runs: that save also confirms the masks. */
  const confirmReviewRef = useRef(false);
  /** Another tab's saved edits were loaded into an untouched editor. */
  const [updatedElsewhere, setUpdatedElsewhere] = useState(false);
  const onAdoptedElsewhereRef = useRef(onAdoptedElsewhere);
  onAdoptedElsewhereRef.current = onAdoptedElsewhere;

  const adoptEntry = useCallback((next: StepEntry) => {
    entryRef.current = next;
    revisionRef.current = imageEditRevisionOf(next);
    setEntry(next);
    setReviewRequired(getEntryPrivacyState(next).reviewRequired);
  }, []);

  const session = useImageEditSession({
    initialItems,
    persist: async (items) => {
      const confirmReview = confirmReviewRef.current;
      try {
        revisionRef.current = await saveEntryImageEdits(
          entryRef.current,
          splitItems(items),
          { imageEditRevision: revisionRef.current, confirmReview },
        );
        if (confirmReview) setReviewRequired(false);
      } catch (error) {
        if (
          !(error instanceof StepImageEditConflictError) &&
          !(error instanceof StepUpdateConflictError)
        )
          throw error;
        // Saving over what another tab stored would delete its masks: show that instead.
        const latest = await loadLatestEntry(entryRef.current);
        if (!latest) throw error;
        adoptEntry(latest);
        throw new ImageEditSessionConflict(itemsOf(latest), { cause: error });
      }
    },
  });

  // Edits made here meanwhile are checked when they are written.
  const { adoptIfSettled } = session;
  useEffect(() => {
    let disposed = false;
    let running: Promise<void> | null = null;
    let again = false;
    const check = async () => {
      do {
        again = false;
        const current = entryRef.current;
        if (!(await isEntryImageStale(current, revisionRef.current))) continue;
        const latest = await loadLatestEntry(current).catch(() => null);
        if (disposed || !latest) continue;
        // Revisions only move forward: an older read never replaces what this editor saved since.
        const newer =
          imageEditRevisionOf(latest) > revisionRef.current ||
          captureRevisionOf(latest) !== captureRevisionOf(entryRef.current);
        if (newer && adoptIfSettled(itemsOf(latest))) {
          adoptEntry(latest);
          onAdoptedElsewhereRef.current();
          setUpdatedElsewhere(true);
        }
      } while (again && !disposed);
    };
    const unsubscribe = subscribeProjectsChanged(() => {
      if (running) {
        again = true;
        return;
      }
      running = check()
        .catch((error) => {
          console.warn('[stepmark] failed to check for image edits made elsewhere', error);
        })
        .finally(() => {
          running = null;
        });
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [adoptEntry, adoptIfSettled]);

  const commit = (next: ImageEditItem[]) => {
    setUpdatedElsewhere(false);
    session.commit(next);
  };

  /** Writes every pending change; `confirmReview` also confirms masks awaiting review. */
  const saveAll = async (confirmReview: boolean) => {
    confirmReviewRef.current = confirmReview;
    try {
      await session.flush({ force: confirmReview });
    } finally {
      confirmReviewRef.current = false;
    }
  };

  return { entry, session, commit, saveAll, reviewRequired, updatedElsewhere };
}
