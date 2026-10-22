import { useCallback, useRef, useState } from 'react';
import { browser, type Browser } from 'wxt/browser';
import type { ContinuationTabOption, PreparedCapturePermission } from '@/lib/editor/editor-app-model';
import {
  defaultContinuationTab,
  listRecordableTabs,
  validatePreparedPermissionSource,
} from '@/lib/editor/continuation-tabs';
import {
  recaptureTargetForEntry,
  requestContinuationPreflight,
  requestRecapturePreflight,
  startRecordingOrThrow,
  startStepRecaptureOrThrow,
} from '@/lib/editor/capture-permission-requests';
import { isRecordableTab } from '@/lib/shared/restricted-urls';
import { focusTab } from '@/lib/runtime/navigation';
import { reportError } from '@/components/shared/report-error';
import { entryId, type StepEntry } from '@/lib/storage/models';
import type { RecordingMode } from '@/lib/storage/recording-state';
import { t } from '@/lib/shared/i18n';

interface UsePermissionFlowOptions {
  sessionId: string | null;
  operationActive: boolean;
  /** Resolves once every queued data operation has finished; a flow starts only after them. */
  whenIdle: () => Promise<void>;
  flushDescriptions: () => Promise<void>;
  requireSelectedEntry: (expectedEntryId?: string) => StepEntry;
  setOperationError: (message: string | null) => void;
  /** The mode of the entry a continuation follows (the last entry when none is named); it is the picker's default. */
  entryMode: (entryId?: string) => RecordingMode;
}

/** Captured at the start of an asynchronous continuation; `isCurrent()` is
 * re-checked after every await so a cancelled or superseded flow can never
 * apply state or errors for an earlier attempt. */
interface FlowToken {
  isCurrent(): boolean;
}

/**
 * The source-permission state machine for recapture and continuation runs.
 * - `generation` increments on every begin/clear; async continuations re-check it via FlowToken
 *   so a cancelled or superseded flow can never apply stale state or errors.
 * - `lock` is held from preflight until the flow clears, blocking new data operations and re-entrant preflights;
 *   operations queued before it finish first (`whenIdle`).
 * - `flowEntryId`/`flowSessionId` bind a prepared grant to its entry/Project; a selection or session change cancels it.
 */
export function usePermissionFlow({
  sessionId,
  operationActive,
  whenIdle,
  flushDescriptions,
  requireSelectedEntry,
  setOperationError,
  entryMode,
}: UsePermissionFlowOptions) {
  const [preparedPermission, setPreparedPermission] = useState<PreparedCapturePermission | null>(null);
  const [permissionPending, setPermissionPending] = useState(false);
  const [continueElsewherePending, setContinueElsewherePending] = useState(false);
  const [continueElsewhereError, setContinueElsewhereError] = useState<string | null>(null);
  /** Non-null once the elsewhere path opened its explicit tab picker. */
  const [continuationTabs, setContinuationTabs] = useState<ContinuationTabOption[] | null>(null);
  const [selectedContinuationTabId, setSelectedContinuationTabId] = useState<number | null>(null);
  const [continuationMode, setContinuationMode] = useState<RecordingMode>('steps');
  const lock = useRef(false);
  const generation = useRef(0);
  const flowEntryId = useRef<string | null>(null);
  const flowSessionId = useRef<string | null>(null);
  /** Entry a continuation inserts after; undefined appends at the end. */
  const [insertAfterEntryId, setInsertAfterEntryId] = useState<string | undefined>(undefined);
  const permissionFlowActive = preparedPermission !== null || permissionPending;

  const isPermissionFlowLocked = useCallback(() => lock.current, []);

  function tokenFor(flowGeneration: number): FlowToken {
    return { isCurrent: () => generation.current === flowGeneration };
  }

  /** A token for the flow that is current right now (no generation bump). */
  function currentFlowToken(): FlowToken {
    return tokenFor(generation.current);
  }

  const clearPreparedPermission = useCallback(() => {
    generation.current += 1;
    lock.current = false;
    flowEntryId.current = null;
    flowSessionId.current = null;
    setPreparedPermission(null);
    setPermissionPending(false);
    setContinueElsewherePending(false);
    setContinueElsewhereError(null);
    setContinuationTabs(null);
    setSelectedContinuationTabId(null);
    setInsertAfterEntryId(undefined);
  }, []);

  /** Cancels a prepared grant when the selection or Project it was bound to is
   * no longer current. */
  const syncWithSelection = useCallback((selectedEntryId: string | null, currentSessionId: string | null) => {
    const boundEntryId = flowEntryId.current;
    if (!boundEntryId) return;
    if (boundEntryId !== selectedEntryId || flowSessionId.current !== currentSessionId) {
      clearPreparedPermission();
    }
  }, [clearPreparedPermission]);

  /** Whether a new flow may begin: the editor must be viewing a Project with no
   * live run and no flow already holding the lock. */
  function canBeginFlow(): boolean {
    return Boolean(sessionId) && !lock.current && !operationActive;
  }

  /**
   * Guards shared by every confirm step: a flow must be prepared, current, and not mid-transition.
   * `kind` additionally requires the shape ('origin' source vs continuation action) being acted on.
   */
  function currentPreparedFlow(kind: 'origin' | 'continuation'): PreparedCapturePermission | null {
    const prepared = preparedPermission;
    if (
      !prepared ||
      !sessionId ||
      permissionPending ||
      continueElsewherePending ||
      !lock.current ||
      flowSessionId.current !== sessionId
    ) {
      return null;
    }
    if (kind === 'origin' && prepared.source.kind !== 'origin') return null;
    if (kind === 'continuation' && prepared.action.kind !== 'continuation') return null;
    return prepared;
  }

  /** Shared failure leg of every flow catch: logs under `label`, then surfaces the localized error
   * (or `fallback`) unless the flow has been superseded meanwhile. */
  function failFlow(flow: FlowToken, label: string, error: unknown, fallback: string): void {
    const message = reportError(label, error, fallback);
    if (flow.isCurrent()) setOperationError(message);
  }

  /** Flushes pending descriptions before starting a run. Returns false when
   * the flush failed or the flow went stale while flushing. */
  async function flushOrBail(flow: FlowToken): Promise<boolean> {
    try {
      await flushDescriptions();
    } catch {
      // flushDescriptions already surfaced its own localized message.
      return false;
    }
    return flow.isCurrent();
  }

  function beginPermissionPreflight(entryIdToPrepare: string | null): FlowToken | null {
    if (!canBeginFlow()) return null;
    const nextGeneration = generation.current + 1;
    generation.current = nextGeneration;
    lock.current = true;
    flowEntryId.current = entryIdToPrepare;
    flowSessionId.current = sessionId;
    setPreparedPermission(null);
    setPermissionPending(true);
    setOperationError(null);
    return tokenFor(nextGeneration);
  }

  function finishPermissionPreflight(flow: FlowToken, prepared: PreparedCapturePermission | null): void {
    if (!flow.isCurrent()) return;
    setPermissionPending(false);
    if (prepared) {
      setPreparedPermission(prepared);
      return;
    }
    lock.current = false;
    flowEntryId.current = null;
    flowSessionId.current = null;
  }

  async function confirmPreparedPermission(): Promise<void> {
    const prepared = currentPreparedFlow('origin');
    if (!prepared || prepared.source.kind !== 'origin' || !sessionId) return;

    const flow = currentFlowToken();
    setPermissionPending(true);
    setOperationError(null);

    try {
      // Callers void this promise, so guard throws must stay inside the try to surface via setOperationError.
      if (prepared.entryId) requireSelectedEntry(prepared.entryId);
      validatePreparedPermissionSource(prepared.source.sourceOrigin, prepared.source.permissionPattern);
      // Must remain the first async browser API call in this click handler so Chromium preserves transient user activation.
      const granted = await browser.permissions.request({ origins: [prepared.source.permissionPattern] });
      if (!flow.isCurrent()) return;
      if (!granted) throw new Error(t().editor.permission.accessRequired);

      if (!(await flushOrBail(flow))) return;
      if (prepared.action.kind === 'continuation') {
        await startRecordingOrThrow({
          type: 'START_RECORDING',
          sessionId,
          mode: continuationMode,
          continuation: {},
          insertAfterEntryId,
        });
        return;
      }
      await startStepRecaptureOrThrow(sessionId, prepared.action.target);
    } catch (permissionError) {
      failFlow(flow, '[howbeam] failed to authorize and start source recording', permissionError, t().editor.permission.sourceStartFailed);
    } finally {
      if (flow.isCurrent()) clearPreparedPermission();
    }
  }

  /**
   * First elsewhere step: lists open recordable tabs for an explicit pick. Recency auto-picking was
   * removed since it kept choosing the tab just recorded; the most recent tab with a different URL is preselected instead.
   */
  async function openContinueElsewhere(): Promise<void> {
    const prepared = currentPreparedFlow('continuation');
    if (!prepared) return;
    const flow = currentFlowToken();
    setContinueElsewherePending(true);
    setContinueElsewhereError(null);
    setOperationError(null);

    try {
      const tabs = await listRecordableTabs();
      if (!flow.isCurrent()) return;
      if (tabs.length === 0) {
        setContinuationTabs(null);
        setSelectedContinuationTabId(null);
        setContinueElsewhereError(t().editor.permission.noRecordableTabs);
        return;
      }
      const lastStepUrl = prepared.source.kind === 'origin' ? prepared.source.sourceUrl : null;
      setContinuationTabs(tabs);
      setSelectedContinuationTabId(defaultContinuationTab(tabs, lastStepUrl)?.id ?? null);
    } catch (listError) {
      console.error('[howbeam] failed to list continuation tabs', listError);
      if (flow.isCurrent()) {
        setContinueElsewhereError(t().editor.permission.tabsUnreadable);
      }
    } finally {
      if (flow.isCurrent()) setContinueElsewherePending(false);
    }
  }

  /**
   * Second elsewhere step: focuses the chosen tab and sends a plain START_RECORDING (the popup's
   * contract) — the background records the active tab under grants it already holds, so no
   * host-permission request happens here and the editor never nominates a source URL.
   */
  async function confirmContinueElsewhere(): Promise<void> {
    if (!currentPreparedFlow('continuation')) return;
    const target = continuationTabs?.find((tab) => tab.id === selectedContinuationTabId) ?? null;
    if (!target) return;
    const flow = currentFlowToken();
    setContinueElsewherePending(true);
    setContinueElsewhereError(null);
    setOperationError(null);
    // The dialog stays open only for the "picked tab disappeared" outcome; every other outcome settles the flow.
    let keepDialogOpen = false;

    try {
      if (!(await flushOrBail(flow))) return;

      // The background resolves a plain start against the active tab of the last focused window, so
      // activate and focus the target tab first, then confirm the switch took before sending the message.
      let confirmed: Browser.tabs.Tab;
      try {
        await focusTab(target.id, target.windowId);
        confirmed = await browser.tabs.get(target.id);
      } catch (switchError) {
        // The picked tab closed while the dialog was open; refresh the list instead of using a stale choice.
        console.warn('[howbeam] failed to switch to the chosen continuation tab', switchError);
        if (flow.isCurrent()) {
          keepDialogOpen = true;
          setContinueElsewherePending(false);
          await openContinueElsewhere();
        }
        return;
      }
      if (!flow.isCurrent()) return;
      if (!confirmed.active || !isRecordableTab(confirmed)) {
        throw new Error(t().editor.permission.switchTabFailed);
      }

      await startRecordingOrThrow({
        type: 'START_RECORDING',
        sessionId: sessionId!,
        mode: continuationMode,
        insertAfterEntryId,
      });
    } catch (continueError) {
      failFlow(flow, '[howbeam] failed to continue recording on another page', continueError, t().editor.permission.continueElsewhereFailed);
    } finally {
      if (flow.isCurrent() && !keepDialogOpen) clearPreparedPermission();
    }
  }

  async function handleRecapture(): Promise<void> {
    if (!canBeginFlow()) return;
    const currentEntry = requireSelectedEntry();
    const target = recaptureTargetForEntry(currentEntry);
    const targetEntryId = entryId(currentEntry);
    const flow = beginPermissionPreflight(targetEntryId);
    if (flow == null) return;
    let prepared: PreparedCapturePermission | null = null;
    try {
      await whenIdle();
      if (!flow.isCurrent()) return;
      prepared = await requestRecapturePreflight(sessionId!, target, targetEntryId);
    } catch (recaptureError) {
      failFlow(flow, '[howbeam] failed to verify recapture source', recaptureError, t().editor.permission.recaptureSourceUnverified);
    } finally {
      finishPermissionPreflight(flow, prepared);
    }
  }

  // Resuming a recording reopens the Project's own source page and appends its captures, so the
  // editor never has to fabricate a step from an unrelated image.
  async function handleContinueRecording(afterEntryId?: string): Promise<void> {
    if (!canBeginFlow()) return;
    const flow = beginPermissionPreflight(null);
    if (flow == null) return;
    setInsertAfterEntryId(afterEntryId);
    setContinuationMode(entryMode(afterEntryId));
    let prepared: PreparedCapturePermission | null = null;
    try {
      await whenIdle();
      if (!flow.isCurrent()) return;
      prepared = await requestContinuationPreflight(sessionId!, afterEntryId);
    } catch (continuationError) {
      failFlow(flow, '[howbeam] failed to verify continuation source', continuationError, t().editor.permission.continuationSourceUnverified);
    } finally {
      finishPermissionPreflight(flow, prepared);
    }
  }

  return {
    preparedPermission,
    permissionPending,
    permissionFlowActive,
    continueElsewherePending,
    continueElsewhereError,
    continuationTabs,
    selectedContinuationTabId,
    selectContinuationTab: setSelectedContinuationTabId,
    continuationMode,
    setContinuationMode,
    insertAfterEntryId,
    isPermissionFlowLocked,
    clearPreparedPermission,
    syncWithSelection,
    confirmPreparedPermission,
    openContinueElsewhere,
    confirmContinueElsewhere,
    handleRecapture,
    handleContinueRecording,
  };
}
