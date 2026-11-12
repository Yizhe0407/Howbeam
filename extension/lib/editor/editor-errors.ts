import { useCallback, useMemo, useState } from 'react';

/**
 * The editor's flows that can fail. Each reports into its own slot, so one
 * flow clearing its error never hides another flow's, and a later success of
 * one flow does not make the editor look healthy while another is still broken.
 */
export type EditorErrorSource = 'save' | 'selection' | 'mutation' | 'permission' | 'recapture';

export type ReportEditorError = (message: string | null) => void;

interface Slot {
  message: string;
  /** Orders the slots so the banner shows the newest failure. */
  sequence: number;
}

export function useEditorErrors() {
  const [slots, setSlots] = useState<Partial<Record<EditorErrorSource, Slot>>>({});

  const report = useCallback((source: EditorErrorSource, message: string | null) => {
    setSlots((current) => {
      if (message === null) {
        if (!current[source]) return current;
        const { [source]: _cleared, ...rest } = current;
        return rest;
      }
      const sequence = Math.max(0, ...Object.values(current).map((slot) => slot.sequence)) + 1;
      return { ...current, [source]: { message, sequence } };
    });
  }, []);

  /** A setter bound to one flow, for the hooks that only know their own errors. */
  const reporterFor = useCallback((source: EditorErrorSource): ReportEditorError => (message) => report(source, message), [report]);

  const latest = useCallback((sources: readonly EditorErrorSource[]): string | null => {
    let found: Slot | null = null;
    for (const source of sources) {
      const slot = slots[source];
      if (slot && (!found || slot.sequence > found.sequence)) found = slot;
    }
    return found?.message ?? null;
  }, [slots]);

  return useMemo(() => ({ slots, report, reporterFor, latest }), [slots, report, reporterFor, latest]);
}
