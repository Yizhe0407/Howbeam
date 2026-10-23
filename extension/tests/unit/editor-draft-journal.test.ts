// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { PERSISTED_STEP_LIMITS } from '@/lib/storage/persistence-limits';
import {
  clearCommittedDescriptionDraft,
  clearMatchingCommittedDescriptionDrafts,
  DESCRIPTION_DRAFT_JOURNAL_LIMITS,
  readDescriptionDrafts,
  writeDescriptionDraft,
} from '@/lib/editor/editor-draft-journal';
import { firstItems } from '../setup/item-at';

const step = {
  id: 'step-1',
  sessionId: 'project-1',
  description: '已儲存',
};

class StorageProxy implements Storage {
  setCalls = 0;
  failSetCall: number | null = null;

  constructor(private readonly target: Storage) {}

  get length() { return this.target.length; }
  clear() { this.target.clear(); }
  getItem(key: string) { return this.target.getItem(key); }
  key(index: number) { return this.target.key(index); }
  removeItem(key: string) { this.target.removeItem(key); }
  setItem(key: string, value: string) {
    this.setCalls += 1;
    if (this.setCalls === this.failSetCall) throw new DOMException('quota failure', 'QuotaExceededError');
    this.target.setItem(key, value);
  }
}

function recordKeys(): string[] {
  return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter((key): key is string => key?.includes(':v3:') ?? false);
}

beforeEach(() => localStorage.clear());

describe('editor description draft journal', () => {
  it('keeps two writers for the same step isolated and sorts newest first', () => {
    expect(writeDescriptionDraft(step, '分頁 A', 'writer-a', localStorage, 1_000)).toBe(true);
    expect(writeDescriptionDraft(step, '分頁 B', 'writer-b', localStorage, 2_000)).toBe(true);

    expect(readDescriptionDrafts(step, 'writer-a', localStorage, 2_001)).toEqual([
      {
        writerId: 'writer-b',
        description: '分頁 B',
        updatedAt: 2_000,
        belongsToCurrentWriter: false,
        conflictsWithPersistedValue: false,
      },
      {
        writerId: 'writer-a',
        description: '分頁 A',
        updatedAt: 1_000,
        belongsToCurrentWriter: true,
        conflictsWithPersistedValue: false,
      },
    ]);
  });
  it('clears only the completed writer and only when its exact draft committed', () => {
    writeDescriptionDraft(step, 'A 第一版', 'writer-a', localStorage, 1_000);
    writeDescriptionDraft(step, 'B 草稿', 'writer-b', localStorage, 1_001);
    writeDescriptionDraft(step, 'A 最後版', 'writer-a', localStorage, 1_002);

    clearCommittedDescriptionDraft(step, 'writer-a', 'A 第一版', localStorage);
    expect(readDescriptionDrafts(step, 'writer-a', localStorage, 1_003).map((draft) => draft.description)).toEqual([
      'A 最後版',
      'B 草稿',
    ]);

    clearCommittedDescriptionDraft(step, 'writer-a', 'A 最後版', localStorage);
    expect(readDescriptionDrafts(step, 'writer-a', localStorage, 1_004).map((draft) => draft.description)).toEqual([
      'B 草稿',
    ]);
  });
  it('marks a conflict by exact base value rather than a lossy hash', () => {
    writeDescriptionDraft(step, '本機草稿', 'writer-a', localStorage, 1_000);
    expect(
      readDescriptionDrafts({ ...step, description: '其他分頁的新內容' }, 'writer-a', localStorage, 1_001)[0],
    ).toMatchObject({ description: '本機草稿', conflictsWithPersistedValue: true });
    expect(readDescriptionDrafts(step, 'writer-a', localStorage, 1_001)[0]).toMatchObject({
      conflictsWithPersistedValue: false,
    });
  });
  it('clears all and only candidates matching the authoritative commit', () => {
    writeDescriptionDraft(step, '相同內容', 'writer-a', localStorage, 1_000);
    writeDescriptionDraft(step, '相同內容', 'writer-b', localStorage, 1_001);
    writeDescriptionDraft(step, '替代內容', 'writer-c', localStorage, 1_002);

    clearMatchingCommittedDescriptionDrafts(step, '相同內容', localStorage, 1_003);
    expect(readDescriptionDrafts({ ...step, description: '相同內容' }, 'writer-a', localStorage, 1_003)).toEqual([
      expect.objectContaining({ writerId: 'writer-c', description: '替代內容' }),
    ]);
  });
  it('removes expired records instead of restoring stale data', () => {
    writeDescriptionDraft(step, '過期草稿', 'writer-a', localStorage, 1_000);
    expect(
      readDescriptionDrafts(
        step,
        'writer-a',
        localStorage,
        1_000 + DESCRIPTION_DRAFT_JOURNAL_LIMITS.maxAgeMs + 1,
      ),
    ).toEqual([]);
    expect(localStorage.length).toBe(0);

  });
  it('evicts the oldest foreign records at the record cap instead of refusing the live write', () => {
    expect(writeDescriptionDraft(
      { id: 'oldest-step', sessionId: 'project', description: '' },
      'oldest draft',
      'oldest-writer',
      localStorage,
      1_000,
    )).toBe(true);
    for (let index = 0; index < DESCRIPTION_DRAFT_JOURNAL_LIMITS.maxRecords - 1; index += 1) {
      expect(
        writeDescriptionDraft(
          { id: `step-${index}`, sessionId: 'project', description: '' },
          `draft-${index}`,
          `writer-${index}`,
          localStorage,
          1_001 + index,
        ),
      ).toBe(true);
    }

    expect(
      writeDescriptionDraft(
        { id: 'overflow', sessionId: 'project', description: '' },
        'live typing must stay journaled',
        'overflow-writer',
        localStorage,
        2_000,
      ),
    ).toBe(true);

    // The oldest foreign record was reclaimed; everything newer, including the live draft, survives.
    expect(
      readDescriptionDrafts({ id: 'oldest-step', sessionId: 'project', description: '' }, 'observer', localStorage, 2_001),
    ).toEqual([]);
    expect(
      readDescriptionDrafts({ id: 'step-0', sessionId: 'project', description: '' }, 'observer', localStorage, 2_001)[0]?.description,
    ).toBe('draft-0');
    expect(
      readDescriptionDrafts({ id: 'overflow', sessionId: 'project', description: '' }, 'observer', localStorage, 2_001)[0]?.description,
    ).toBe('live typing must stay journaled');
  });
  it('never evicts the current writer’s own drafts for other steps', () => {
    for (let index = 0; index < DESCRIPTION_DRAFT_JOURNAL_LIMITS.maxRecords; index += 1) {
      expect(
        writeDescriptionDraft(
          { id: `step-${index}`, sessionId: 'project', description: '' },
          `own-draft-${index}`,
          'busy-writer',
          localStorage,
          1_000 + index,
        ),
      ).toBe(true);
    }

    // Every journaled record may be the only copy of text this same user just typed, so the overflowing write fails instead of sacrificing one.
    expect(
      writeDescriptionDraft(
        { id: 'one-too-many', sessionId: 'project', description: '' },
        'over the cap',
        'busy-writer',
        localStorage,
        2_000,
      ),
    ).toBe(false);
    expect(
      readDescriptionDrafts({ id: 'step-0', sessionId: 'project', description: '' }, 'observer', localStorage, 2_001)[0]?.description,
    ).toBe('own-draft-0');
  });

  it('stores a maximum-length draft and restores it exactly', () => {
    const maximum = 'x'.repeat(PERSISTED_STEP_LIMITS.maxStepDescriptionLength);
    expect(writeDescriptionDraft({ ...step, description: '' }, maximum, 'writer-a', localStorage, 1_000)).toBe(true);
    expect(readDescriptionDrafts({ ...step, description: '' }, 'writer-a', localStorage, 1_001)[0]?.description).toBe(maximum);
  });

  it('refuses a draft longer than a step description may be', () => {
    const tooLong = 'x'.repeat(PERSISTED_STEP_LIMITS.maxStepDescriptionLength + 1);
    expect(writeDescriptionDraft({ ...step, description: '' }, tooLong, 'writer-a', localStorage, 1_000)).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it('retains the previous record when a write fails', () => {
    writeDescriptionDraft(step, '完整舊草稿', 'writer-a', localStorage, 1_000);
    const storage = new StorageProxy(localStorage);
    storage.failSetCall = 1;

    expect(writeDescriptionDraft(step, '完整舊草稿加一字', 'writer-a', storage, 1_001)).toBe(false);
    expect(readDescriptionDrafts(step, 'writer-a', localStorage, 1_002)[0]?.description).toBe('完整舊草稿');
  });

  it('drops a record filed under another record key instead of trusting its contents', () => {
    writeDescriptionDraft(step, '安全草稿 A', 'writer-a', localStorage, 1_000);
    writeDescriptionDraft(step, '安全草稿 B', 'writer-b', localStorage, 1_001);
    const [keyA, keyB] = firstItems(recordKeys().sort(), 2);
    localStorage.setItem(keyA, localStorage.getItem(keyB)!);

    expect(readDescriptionDrafts(step, 'observer', localStorage, 1_002)).toEqual([
      expect.objectContaining({ writerId: 'writer-b', description: '安全草稿 B' }),
    ]);
    expect(recordKeys()).toEqual([keyB]);
  });
});
