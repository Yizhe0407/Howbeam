import { useEffect, useMemo, useRef, useState } from 'react';
import { entryId, type StepEntry } from '@/lib/storage/models';
import { DraftConfirmationRequiredError } from './editor-autosave';

interface UseEditorEntryWorkspaceOptions {
  entries: StepEntry[];
  flushDescriptions: () => Promise<void>;
  isSelectionBlocked: () => boolean;
  onSelectionInteraction: () => void;
  onSelectionSaved: () => void;
}

/** Keeps the editor's single active timeline entry and view-only state together. */
export function useEditorEntryWorkspace({
  entries,
  flushDescriptions,
  isSelectionBlocked,
  onSelectionInteraction,
  onSelectionSaved,
}: UseEditorEntryWorkspaceOptions) {
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const requestedEntryId = useMemo(() => new URLSearchParams(window.location.search).get('entryId'), []);
  const appliedRequestedEntry = useRef(false);
  const [zoomOpen, setZoomOpen] = useState(false);

  useEffect(() => {
    setSelectedEntryId((current) => {
      const [first] = entries;
      if (!first) return null;
      if (current && entries.some((entry) => entryId(entry) === current)) return current;
      return entryId(first);
    });
  }, [entries]);

  useEffect(() => {
    if (appliedRequestedEntry.current || !requestedEntryId) return;
    if (!entries.some((entry) => entryId(entry) === requestedEntryId)) return;
    appliedRequestedEntry.current = true;
    setSelectedEntryId(requestedEntryId);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('#howbeam-editor-title')?.focus());
  }, [entries, requestedEntryId]);

  const selectedIndex = entries.findIndex((entry) => entryId(entry) === selectedEntryId);
  const selectedEntry = selectedIndex === -1 ? undefined : entries[selectedIndex];

  async function selectEntry(id: string): Promise<void> {
    if (isSelectionBlocked() || id === selectedEntryId) return;
    if (!entries.some((entry) => entryId(entry) === id)) return;
    onSelectionInteraction();
    try {
      await flushDescriptions();
    } catch (error) {
      // A pending confirmation intentionally blocks the switch: keep the
      // current field mounted so its unsaved draft remains available. Any
      // other failure (a genuine DB error) must reach the caller — swallowing
      // it here would make the click silently do nothing.
      if (error instanceof DraftConfirmationRequiredError) return;
      throw error;
    }
    onSelectionSaved();
    setSelectedEntryId(id);
  }

  return {
    selectedEntry,
    selectedEntryId,
    selectedIndex,
    setSelectedEntryId,
    setZoomOpen,
    selectEntry,
    zoomOpen,
  };
}
