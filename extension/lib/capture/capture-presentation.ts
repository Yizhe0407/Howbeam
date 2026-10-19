/**
 * Capture-only styling for Howbeam overlays and the top-level viewport
 * scrollbar. Everything stays in layout so fixed/sticky content and viewport
 * coordinates do not move while a screenshot is being composed.
 */
/** Eases an overlay back after the capture-time hide; set on the host so it runs once the hide rule is removed. */
export const REAPPEAR_TRANSITION = 'opacity 160ms ease';

export const CAPTURE_PRESENTATION_CSS = `
/* Howbeam's interaction layers are capture-only UI. Keep their hosts in
 * the document so layout and viewport coordinates remain unchanged, and make
 * them fully transparent while captureVisibleTab samples the page.
 *
 * Transparent, never visibility:hidden: a hidden layer stops being hit-tested,
 * so a press aimed at the toolbar (or the snapshot shield, or the region
 * selector) during a capture would fall through to the page element beneath
 * it and be executed and recorded there. Opacity on the host also hides the
 * whole subtree — no descendant can opt back into being painted. */
[data-howbeam-snapshot-shield],
[data-howbeam-step-preview],
[data-howbeam-recording-toolbar],
[data-howbeam-region-capture] {
  opacity: 0 !important;
  /* Hiding must be instant or the overlay would still be partly visible in the
   * screenshot. Restoring is not: the toolbar and shield declare an opacity
   * transition, which only runs once this rule is gone, so they fade back in
   * instead of popping into view after every capture. */
  transition: none !important;
}

:root::-webkit-scrollbar,
body::-webkit-scrollbar,
:root::-webkit-scrollbar-track,
body::-webkit-scrollbar-track,
:root::-webkit-scrollbar-track-piece,
body::-webkit-scrollbar-track-piece,
:root::-webkit-scrollbar-thumb,
body::-webkit-scrollbar-thumb,
:root::-webkit-scrollbar-button,
body::-webkit-scrollbar-button,
:root::-webkit-scrollbar-corner,
body::-webkit-scrollbar-corner,
:root::-webkit-resizer,
body::-webkit-resizer {
  background: transparent !important;
  border-color: transparent !important;
  box-shadow: none !important;
}

:root {
  scrollbar-color: transparent transparent !important;
}

:root > :not(body),
body {
  scrollbar-color: auto !important;
}

body * {
  scrollbar-color: auto;
}
`;

export interface CapturePresentationAdapter {
  insert(): Promise<void>;
  settle(): Promise<void>;
  remove(): Promise<void>;
}

/**
 * Applies capture-only presentation without exposing a half-applied state to
 * callers. Removal runs after settling or capture fails.
 */
export async function withCapturePresentation<T>(
  adapter: CapturePresentationAdapter,
  capture: () => Promise<T>,
): Promise<T> {
  let inserted = false;
  let result: T | undefined;
  let failure: unknown;
  let failed = false;

  try {
    await adapter.insert();
    inserted = true;
    await adapter.settle();
    result = await capture();
  } catch (error) {
    failed = true;
    failure = error;
  }

  if (inserted) {
    try {
      await adapter.remove();
    } catch (restoreError) {
      if (failed) {
        throw new AggregateError([failure, restoreError], 'Capture failed and its presentation could not be restored.');
      }
      throw restoreError;
    }
  }

  if (failed) throw failure;
  return result as T;
}

/** Runs inside the captured tab through scripting.executeScript. */
export async function waitForCapturePresentationPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
