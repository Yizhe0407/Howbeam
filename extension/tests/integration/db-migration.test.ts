import 'fake-indexeddb/auto';
import { afterAll, describe, expect, it } from 'vitest';
import { openDB } from 'idb';
import { closeDatabase, DATABASE_VERSION } from '@/lib/storage/database';
import { getSteps } from '@/lib/storage/step-repository';
import { getEntryImageEdits, type Step } from '@/lib/storage/models';

afterAll(closeDatabase);

/** A version 1 database as an older build left it, holding text written under the old rule. */
async function seedVersion1(steps: readonly Step[]): Promise<void> {
  const db = await openDB('stepmark', 1, {
    upgrade(database) {
      database.createObjectStore('steps', { keyPath: 'id' }).createIndex('by-session', 'sessionId');
      database.createObjectStore('projects', { keyPath: 'id' }).createIndex('by-updated-at', 'updatedAt');
    },
  });
  for (const step of steps) await db.put('steps', step);
  db.close();
}

const textEdit = (id: string, text: string) => ({
  id, kind: 'text', bounds: { x: 1, y: 1, width: 50, height: 20 }, text, fontSize: 16, color: '#111111', look: 'plain',
});

describe('database version 2', () => {
  it('rewrites step text written under the old rule instead of losing it', async () => {
    expect(DATABASE_VERSION).toBe(2);
    await seedVersion1([{
      id: 'step-1', sessionId: 'project-1', order: 0, bounds: null, devicePixelRatio: 1,
      description: '下一行\u0085開始', url: 'https://example.com/', timestamp: 1,
      imageEdits: [textEdit('kept', '標註\u0085文字'), textEdit('emptied', '\u0085'), textEdit('clean', '原樣')],
    } as unknown as Step]);

    const [step] = await getSteps('project-1');
    expect(step.description).toBe('下一行開始');
    expect(step.imageEdits?.map((edit) => edit.kind === 'text' ? edit.text : null)).toEqual(['標註文字', '原樣']);
    const entry = { kind: 'single', step: { ...step, screenshotBlob: new Blob() } } as const;
    expect(getEntryImageEdits(entry).map((edit) => edit.id)).toEqual(['kept', 'clean']);
  });
});
