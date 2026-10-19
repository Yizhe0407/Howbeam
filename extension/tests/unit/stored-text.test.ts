import { describe, expect, it } from 'vitest';
import { isStoredText, normalizeStoredLine, normalizeStoredText } from '@/lib/storage/stored-text';
import { sanitizeProject, sanitizeStepForStorage, type Project, type Step } from '@/lib/storage/models';
import { sanitizeProjectTag } from '@/lib/storage/project-tag-model';
import { validateRuntimeStep } from '@/lib/export/project-archive-validation';

const EVERY_LOW_CODE_UNIT = Array.from({ length: 0x100 }, (_, code) => String.fromCharCode(code)).join('');

function step(description: string): Step {
  return {
    id: 'step-1',
    sessionId: 'session-1',
    order: 0,
    bounds: null,
    devicePixelRatio: 1,
    description,
    url: 'https://example.com/',
    timestamp: 1,
  };
}

describe('stored text rule', () => {
  it('keeps tab and newlines but drops every other C0 control, DEL and C1 control', () => {
    expect(normalizeStoredText('a\tb\nc\r\vd\fe\u0007f\u007fg\u0085h\u009fi ')).toBe('a\tb\nc\rdefghi ');
    expect(normalizeStoredLine('a\tb\nc\u0085d')).toBe('abcd');
  });

  it('accepts exactly what it normalizes to', () => {
    const normalized = normalizeStoredText(EVERY_LOW_CODE_UNIT);
    expect(isStoredText(normalized)).toBe(true);
    for (const character of EVERY_LOW_CODE_UNIT) {
      expect(isStoredText(character)).toBe(normalizeStoredText(character) === character);
    }
  });

  // What storage keeps must always pass archive validation, or a saved project could never be exported.
  it('stores only descriptions and project text the archive accepts', () => {
    const stored = sanitizeStepForStorage(step(EVERY_LOW_CODE_UNIT));
    expect(() => validateRuntimeStep(stored, 'steps[0]')).not.toThrow();
    expect(() => validateRuntimeStep(step('a\u0085b'), 'steps[0]')).toThrow(/control characters/);

    const project = sanitizeProject({
      id: 'p', title: `標題${EVERY_LOW_CODE_UNIT}`, description: EVERY_LOW_CODE_UNIT, sections: [], tags: [`tag\u0085x`],
      createdAt: 1, updatedAt: 1, contentRevision: 0, stepEditRevision: 0, metadataRevision: 0, stepCount: 0, entryCount: 0, storageBytes: 0,
    } as Project);
    expect(isStoredText(project.title)).toBe(true);
    expect(isStoredText(project.description)).toBe(true);
    expect(project.tags).toEqual(['tagx']);
    expect(sanitizeProjectTag('a\u0007b')).toBe('ab');
  });
});
