import { browser } from 'wxt/browser';
import { installSnapshotFrameProbe } from '@/lib/recording/snapshot-targeting';
import { installSnapshotFrameFreeze, installStepFrameRecorder } from '@/lib/recording/frame-relay';
import { getRecordingState } from '@/lib/storage/storage';
import { installRecaptureRecorder } from '@/lib/recording/recapture-recorder';
import { initLocalePreference } from '@/lib/runtime/locale-preference';
import { detectUnrecordablePage, isChildFrameUnrecordable } from '@/lib/recording/content/recordable-page';
import { addRecorderCleanup, runRecorderCleanup } from '@/lib/recording/content/recorder-cleanup';
import { documentRole } from '@/lib/recording/content/document-role';
import { mountTopRecorder } from '@/lib/recording/content/top-recorder';

/** The live recorder module of this document's extension world. */
const RECORDER_KEY = `__howbeam_recorder_${browser.runtime.id}`;

interface ResidentRecorder {
  /** Runs one recorder start in the module instance that owns this document. */
  start(): Promise<void>;
  /** False once the extension that loaded this instance was reloaded or
   * updated (an orphaned content script has no runtime left). */
  isAlive(): boolean;
}

function isRuntimeAlive(): boolean {
  try {
    return Boolean(browser.runtime?.id);
  } catch {
    return false;
  }
}

export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime',
  main() {
    // The background injects this bundle on every start, resume, mode switch
    // and navigation. Each injection evaluates a fresh copy of every module —
    // React included — and React leaves document-level listeners behind that
    // nothing removes, so letting each copy run would pin every previous
    // copy (its fiber trees, toolbar host and listeners) for the life of the
    // page. Only the first copy in a document ever runs; later injections just
    // ask it to start again, and are garbage once this returns.
    const host = globalThis as unknown as Record<string, unknown>;
    const resident = host[RECORDER_KEY] as ResidentRecorder | undefined;
    if (resident && typeof resident.start === 'function' && resident.isAlive()) return resident.start();
    const recorder: ResidentRecorder = { start: startRecorder, isAlive: isRuntimeAlive };
    host[RECORDER_KEY] = recorder;
    return startRecorder();
  },
});

/** Bumped by every start; a start that was overtaken backs out at its next await. */
let currentStart = 0;

/** Tears down whatever the last start mounted, then mounts what the run needs in this document now. */
async function startRecorder(): Promise<void> {
  runRecorderCleanup();
  const start = ++currentStart;
  const isCurrent = () => start === currentStart;
  // The in-page toolbar follows the chosen language until the next start.
  void initLocalePreference().then((stopFollowing) => {
    if (!isCurrent()) {
      stopFollowing();
      return;
    }
    addRecorderCleanup(stopFollowing);
  });

  const recordingState = await getRecordingState();
  if (!isCurrent()) return;
  const isTop = window.top === window;
  const role = documentRole(recordingState, {
    isTop,
    unrecordable: isTop ? detectUnrecordablePage() : null,
    underUnrecordablePage: !isTop && isChildFrameUnrecordable(),
  });

  switch (role.kind) {
    case 'none':
      return;
    case 'recapture':
      await installRecaptureRecorder(role.context);
      return;
    case 'probe':
      installSnapshotFrameProbe(role.runId);
      // The shield only covers the top viewport, so each child must freeze
      // itself and report pixel-shifting scrolls upward.
      if (role.freeze) installSnapshotFrameFreeze();
      return;
    case 'step-child':
      // Child frames capture their own clicks and relay them (with rects
      // mapped hop-by-hop into the top viewport) to the top-frame recorder.
      installStepFrameRecorder(role.runId, role.paused);
      return;
    case 'top':
      await mountTopRecorder({
        recordingState,
        runId: role.runId,
        unrecordable: role.unrecordable,
        shouldFreezeSnapshot: role.freezeSnapshot,
        isCurrent,
      });
  }
}
