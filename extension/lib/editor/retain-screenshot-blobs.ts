import type { ScreenshotStep, StepEntry } from '@/lib/storage/models';

/**
 * IndexedDB hands back a brand-new Blob object on every read, even when the
 * stored image is byte-for-byte the same. Everything that shows a screenshot
 * keys its object URL on Blob identity, so each reload of the editor data
 * (after any edit) would revoke every URL and make every thumbnail reload and
 * flash. A step's image only changes when it is recaptured, which bumps
 * `captureRevision`, so an unchanged step can safely keep its previous Blob.
 */
function canReuse(previous: ScreenshotStep | undefined, next: ScreenshotStep): boolean {
  return (
    previous !== undefined &&
    previous.id === next.id &&
    (previous.captureRevision ?? 0) === (next.captureRevision ?? 0) &&
    previous.screenshotBlob.size === next.screenshotBlob.size &&
    previous.screenshotBlob.type === next.screenshotBlob.type
  );
}

function imageOwner(entry: StepEntry): ScreenshotStep {
  return entry.kind === 'single' ? entry.step : entry.anchor;
}

export function retainScreenshotBlobs(previous: readonly StepEntry[], next: readonly StepEntry[]): StepEntry[] {
  const previousById = new Map(previous.map((entry) => [imageOwner(entry).id, imageOwner(entry)]));
  return next.map((entry): StepEntry => {
    const owner = imageOwner(entry);
    const earlier = previousById.get(owner.id);
    if (!canReuse(earlier, owner) || earlier!.screenshotBlob === owner.screenshotBlob) return entry;
    const retained = { ...owner, screenshotBlob: earlier!.screenshotBlob };
    return entry.kind === 'single' ? { ...entry, step: retained } : { ...entry, anchor: retained };
  });
}
