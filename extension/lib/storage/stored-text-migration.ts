import type { Step } from './models';
import { normalizeStoredText } from './stored-text';

/** Rewrites text older builds stored (e.g. with U+0085) to the current stored-text
 * rule, which strict readers would otherwise drop. Null when nothing changed. */
export function conformStepToStoredTextRule(step: Step): Step | null {
  let changed = false;
  const next: Step = { ...step };

  if (typeof step.description === 'string') {
    const description = normalizeStoredText(step.description);
    if (description !== step.description) {
      next.description = description;
      changed = true;
    }
  }

  if (Array.isArray(step.imageEdits)) {
    let editsChanged = false;
    const edits: unknown[] = [];
    for (const edit of step.imageEdits as unknown[]) {
      const record = edit as { kind?: unknown; text?: unknown } | null;
      if (record && typeof record === 'object' && record.kind === 'text' && typeof record.text === 'string') {
        const text = normalizeStoredText(record.text);
        if (text !== record.text) {
          editsChanged = true;
          if (text.trim()) edits.push({ ...record, text });
          continue;
        }
      }
      edits.push(edit);
    }
    if (editsChanged) {
      next.imageEdits = edits as Step['imageEdits'];
      changed = true;
    }
  }

  return changed ? next : null;
}
